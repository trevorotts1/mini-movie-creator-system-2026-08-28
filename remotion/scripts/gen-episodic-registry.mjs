// Episodic composition registry generator (spec §21 — episodic timeline).
// Reads src/episodic/episodic-plan.json (DB-derived plan: series/episodes/
// scenes/shots) and writes src/episodic/episode-registry.gen.ts, which
// Root.tsx maps to one <Composition> per episode via EpisodeComposition.
// Falls back to episodic-plan.example.json when no real plan exists yet so
// `npm run gen` and `npx tsc --noEmit` stay green on a fresh checkout.
// Plan files are data — parsed, never executed.
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const episodicDir = path.join(root, 'src', 'episodic');

const planPath = path.join(episodicDir, 'episodic-plan.json');
const examplePath = path.join(episodicDir, 'episodic-plan.example.json');
const planFile = existsSync(planPath) ? planPath : examplePath;

if (!existsSync(planFile)) {
  console.error('gen-episodic-registry: no episodic-plan.json or episodic-plan.example.json found');
  process.exit(1);
}

/** strict JSON.parse — the plan is data, never code. */
let plan;
try {
  plan = JSON.parse(readFileSync(planFile, 'utf8'));
} catch (err) {
  console.error(`gen-episodic-registry: ${path.basename(planFile)} is not valid JSON:`, err.message);
  process.exit(1);
}

// ---- plan validation (mirrors @mmcs/remotion-runtime/src/registry/validate.ts) ----
function fail(message) {
  console.error(`gen-episodic-registry: invalid plan: ${message}`);
  process.exit(1);
}
function requirePositiveInt(value, label) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) fail(`${label} must be a positive integer`);
  return value;
}
function requirePositiveNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) fail(`${label} must be a positive finite number`);
  return value;
}
function requireDimension(value, label) {
  const n = requirePositiveNumber(value, label);
  if (!Number.isInteger(n)) fail(`${label} must be an integer number of pixels`);
  return n;
}
function requireNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.length === 0) fail(`${label} must be a non-empty string`);
  return value;
}
function formatEpisodeCode(seasonNumber, episodeNumber) {
  return `S${String(seasonNumber).padStart(2, '0')}E${String(episodeNumber).padStart(2, '0')}`;
}

const series = plan.series || fail('missing "series"');
requireNonEmptyString(series.id, 'series.id');
requirePositiveNumber(series.fps, 'series.fps');
requireDimension(series.width, 'series.width');
requireDimension(series.height, 'series.height');
if (series.compositionIdPrefix !== undefined && !/^[A-Za-z][A-Za-z0-9]*$/.test(series.compositionIdPrefix)) {
  fail('series.compositionIdPrefix must be alphanumeric starting with a letter');
}
if (!Array.isArray(plan.episodes) || plan.episodes.length === 0) fail('plan has no episodes');

const prefix = series.compositionIdPrefix ?? '';
const seenCodes = new Set();
const seenCompositionIds = new Set();
const seenEpisodeIds = new Set();
const seenShotIds = new Set();
const compositions = [];

const episodes = [...plan.episodes].sort((a, b) =>
  a.seasonNumber !== b.seasonNumber
    ? a.seasonNumber - b.seasonNumber
    : a.episodeNumber - b.episodeNumber,
);

for (const episode of episodes) {
  requireNonEmptyString(episode.id, 'episode.id');
  if (seenEpisodeIds.has(episode.id)) fail(`duplicate episode id "${episode.id}"`);
  seenEpisodeIds.add(episode.id);
  const season = requirePositiveInt(episode.seasonNumber, 'episode.seasonNumber');
  const number = requirePositiveInt(episode.episodeNumber, 'episode.episodeNumber');
  const code = formatEpisodeCode(season, number);
  if (seenCodes.has(code)) fail(`duplicate episode code "${code}"`);
  seenCodes.add(code);
  const compositionId = `${prefix}${code}`;
  if (seenCompositionIds.has(compositionId)) fail(`duplicate composition id "${compositionId}"`);
  seenCompositionIds.add(compositionId);

  const fps = episode.fpsOverride ?? series.fps;
  const width = episode.widthOverride ?? series.width;
  const height = episode.heightOverride ?? series.height;
  requirePositiveNumber(fps, `episode fps (${episode.id})`);
  requireDimension(width, `episode width (${episode.id})`);
  requireDimension(height, `episode height (${episode.id})`);

  if (!Array.isArray(episode.scenes) || episode.scenes.length === 0) fail(`episode has no scenes (${episode.id})`);
  const seenSceneIds = new Set();
  const seenSceneIndexes = new Set();
  let previousSceneIndex = 0;
  let cursor = 0;
  const scenes = [];
  for (const scene of episode.scenes) {
    requireNonEmptyString(scene.sceneId, 'scene.sceneId');
    if (seenSceneIds.has(scene.sceneId)) fail(`duplicate scene id "${scene.sceneId}" (${code})`);
    seenSceneIds.add(scene.sceneId);
    requirePositiveInt(scene.sequenceIndex, `scene.sequenceIndex (${scene.sceneId})`);
    if (seenSceneIndexes.has(scene.sequenceIndex)) fail(`duplicate scene sequenceIndex (${code})`);
    seenSceneIndexes.add(scene.sequenceIndex);
    if (scene.sequenceIndex < previousSceneIndex) fail(`scene sequenceIndex out of order (${code})`);
    previousSceneIndex = scene.sequenceIndex;
    if (!Array.isArray(scene.shots) || scene.shots.length === 0) fail(`scene has no shots (${scene.sceneId})`);

    const sceneFrom = cursor;
    let sceneFrames = 0;
    const seenShotIndexes = new Set();
    let previousShotIndex = 0;
    const shots = [];
    for (const shot of scene.shots) {
      requireNonEmptyString(shot.shotId, 'shot.shotId');
      if (seenShotIds.has(shot.shotId)) fail(`duplicate shot id "${shot.shotId}" (${code} / ${scene.sceneId})`);
      seenShotIds.add(shot.shotId);
      requirePositiveInt(shot.sequenceIndex, `shot.sequenceIndex (${shot.shotId})`);
      if (seenShotIndexes.has(shot.sequenceIndex)) fail(`duplicate shot sequenceIndex (${shot.shotId})`);
      seenShotIndexes.add(shot.sequenceIndex);
      if (shot.sequenceIndex < previousShotIndex) fail(`shot sequenceIndex out of order (${shot.shotId})`);
      previousShotIndex = shot.sequenceIndex;
      requirePositiveNumber(shot.targetDurationSeconds, `shot.targetDurationSeconds (${shot.shotId})`);
      const durationInFrames = Math.max(1, Math.round(shot.targetDurationSeconds * fps));
      shots.push({
        shotId: shot.shotId,
        sequenceIndex: shot.sequenceIndex,
        sequenceFrom: sceneFrom + sceneFrames,
        durationInFrames,
        targetDurationSeconds: shot.targetDurationSeconds,
      });
      sceneFrames += durationInFrames;
    }
    scenes.push({
      sceneId: scene.sceneId,
      sequenceIndex: scene.sequenceIndex,
      sequenceFrom: sceneFrom,
      durationInFrames: sceneFrames,
      shots,
    });
    cursor += sceneFrames;
  }

  compositions.push({
    compositionId,
    episodeCode: code,
    seriesId: series.id,
    episodeId: episode.id,
    seasonNumber: season,
    episodeNumber: number,
    fps,
    width,
    height,
    durationInFrames: cursor,
    scenes,
  });
}

// ---- emit episode-registry.gen.ts (data only — no imports of shot components,
// layer mounting is EpisodeComposition's job so the registry compiles standalone) ----
const header = '// AUTO-GENERATED by scripts/gen-episodic-registry.mjs — do not edit.\n';
const json = JSON.stringify(compositions, null, 2);
const out = `${header}import type { EpisodeCompositionConfig } from './types';\n\nexport const episodeCompositions: EpisodeCompositionConfig[] = ${json};\n`;
writeFileSync(path.join(episodicDir, 'episode-registry.gen.ts'), out);

const fps = series.fps;
console.log(`episodic registry: ${compositions.length} episode composition(s) from ${path.basename(planFile)}`);
for (const c of compositions) {
  console.log(`  ${c.compositionId}: ${c.durationInFrames}f @ ${c.fps}fps, ${c.width}x${c.height}, ${c.scenes.length} scene(s)`);
}