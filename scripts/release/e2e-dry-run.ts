/// <reference types="node" />
/**
 * e2e-dry-run.ts — REL-004: one scripted run through EVERY spec §30 pipeline
 * stage against real subsystem code, with zero provider spend and zero live
 * credentials (acceptance: "controlled short sample project … every stage …
 * report written; script exits 0").
 *
 * Stages, in enforced order (spec §3 gates discipline every stage):
 *
 *  S0  preflight        config posture (tryLoadConfig), ffmpeg/ffprobe on PATH
 *  S1  spine            scratch SQLite: migrations + cost schema + repos
 *  S2  intake+concept   mock director transport → generateConcept (gate 1+2)
 *  S3  script           parseScreenplay + estimateRuntime
 *  S4  shot planning    planEpisodeShots over the Agnes 4–12s window
 *  S5  scene masters    classify → plan → approveSceneMasterSpec per scene
 *  S6  keyframes        planKeyframes decisions
 *  S7  reference budget planReferenceBudget packs per shot
 *  S8  storyboards      planStoryboard + MockImageClient frames (DRAFT);
 *                       assertPaidGenerationAllowed fails closed on PENDING
 *  S9  character        candidate flow (3→1) + APPROVED + gate("character")
 *                       + CharacterLockService lock → CANONICAL
 *  S10 gate 4           approveStoryboardPlan; paid path now allows
 *  S11 budget gate      CostLedger: "included" $0 commit + over-limit paid
 *                       request → requires_approval with NO ledger row
 *  S12 agnes submit     AgnesVideoSubmitter persists BUDGET_RESERVED →
 *                       SUBMITTED (providerJobId BEFORE any poll, spec §18)
 *  S13 restart/resume   kill after submit → FRESH store + fresh poll runner
 *                       over the same SQLite: polls the persisted
 *                       providerJobId, createVideo call count stays 1
 *  S14 emergency archiv resumeEmergencyArchival → ARCHIVED (hosted fake);
 *                       BLOCKED path proved separately (EXPIRED_URL)
 *  S15 GHL folders      EpisodeFolderEnsurer (fake client proves
 *                       search-before-create) + EpisodeFolderStore persist
 *  S16 durable store    GoHighLevelMediaStore.archiveAsset → manifest
 *                       linkage; resolve() proves DB-only resolution
 *  S17 dialogue TTS     DialogueTtsRunner persists the job BEFORE synthesis;
 *                       deterministic-asset reuse proven on a second line
 *  S18 QC               17 per-shot checks + runFinalEpisodeQC PASS
 *  S19 rough cut        assembleRoughCut + registry + REAL ffmpeg fixture
 *                       render + ffprobeValidateRoughCut
 *  S20 gate 5           approve("rough-cut") → runFinalRender (fixture
 *                       adapter, REAL ffprobe gate) → archived into 08 Final
 *  S21 canon            bible + proposeEndOfEpisodeChanges + gate("canon")
 *                       + approveAllProposedChanges
 *  S22 checkpoint       CheckpointService save → fresh instance loadExisting
 *                       + toResumeView (the restart boundary)
 *  S23 gates            all six gates APPROVED, in §3 order
 *
 * MOCKED vs LIVE (spec §30 honesty rule): every paid provider (Agnes video,
 * Fish TTS) and the live GHL transport run behind scripted fakes; the report
 * marks live-item coverage BLOCKED (credentials absent — and none of the
 * sample's calls would ever carry real credentials), never silently "passed
 * live". Story text is data everywhere — stored verbatim, never executed.
 *
 * Report: docs/e2e-dry-run-report.md is generated from the same module by
 * running with `--markdown` (see the test file), so the committed report and
 * the script output cannot drift.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ApprovalStore,
  GATE_IDS,
} from "@mmcs/core";
import {
  CheckpointService,
  toResumeView,
} from "../../packages/core/src/recovery/index.js";
import { tryLoadConfig } from "../../packages/core/src/config/index.js";

import {
  AssetRepository as DbAssetRepository,
  CharacterRepository,
  MIGRATIONS,
  SqliteEpisodeRepository,
  SqliteProjectRepository,
  SqliteSeriesRepository,
  connectSqlite,
  formatEpisodeCode,
  type SqliteDatabase,
} from "@mmcs/database";
import { CostLedger, createCostEngineSchema } from "@mmcs/cost-engine";
import {
  QC_CHECK_IDS,
  parseShotQcResult,
  passedCheck,
  rollupVerdict,
} from "@mmcs/qc";
import {
  buildEpisodeCompositionRegistry,
  getCompositionForEpisode,
} from "@mmcs/remotion-runtime";
import { assembleRoughCut } from "../../packages/remotion-runtime/src/rough-cut/assemble.js";
import {
  renderRoughCut,
  makeFfmpegFixtureAdapter,
} from "../../packages/remotion-runtime/src/rough-cut/render.js";
import {
  ffprobeValidate,
  makeFfmpegFixtureAdapter as makeFinalFixtureAdapter,
} from "../../packages/remotion-runtime/src/final-render/ffprobe-fixture.js";
import { runFinalRender } from "../../packages/remotion-runtime/src/final-render/pipeline.js";
import type {
  Resolution as FinalResolution,
} from "../../packages/remotion-runtime/src/final-render/contract.js";

import {
  applySelection,
  generateCandidates,
  startCandidateFlow,
} from "../../packages/character-library/src/candidates/candidate-flow.js";
import { CharacterLockService } from "../../packages/character-library/src/locking/service.js";
import {
  createSeriesBible,
  addEpisodeSummary,
} from "../../packages/character-library/src/series-bible/bible.js";
import {
  proposeEndOfEpisodeChanges as proposeChanges,
  approveAllProposedChanges as approveAllProposed,
} from "../../packages/character-library/src/canon-approval/canon-approval.js";

import {
  parseIntake,
} from "../../packages/scene-intelligence/src/intake/parse.js";
import { prepareDirectorModel } from "../../packages/scene-intelligence/src/concept/director-model.js";
import { generateConcept } from "../../packages/scene-intelligence/src/concept/generator.js";
import { parseScreenplay } from "../../packages/scene-intelligence/src/scene-parser/index.js";
import { estimateRuntime } from "../../packages/scene-intelligence/src/runtime-estimator/index.js";
import { planEpisodeShots } from "../../packages/scene-intelligence/src/shot-planner/shot-planner.js";
import {
  approveSceneMasterSpec,
  classifySceneMasterNeed,
  planSceneMasters,
  type SceneMasterSpec,
} from "../../packages/scene-intelligence/src/scene-master/index.js";
import { planKeyframes } from "../../packages/scene-intelligence/src/keyframe-planner/index.js";
import { planReferenceBudget } from "../../packages/scene-intelligence/src/reference-budget/index.js";
import {
  MockImageClient,
  planStoryboard,
  generateStoryboardFrames,
  storyboardAssetId,
  type StoryboardShotInput,
} from "../../packages/scene-intelligence/src/storyboard/index.js";
import {
  approveStoryboardPlan,
  assertPaidGenerationAllowed,
} from "../../packages/scene-intelligence/src/storyboard/approval/index.js";
import type {
  KeyframeCapabilityProfile,
} from "../../packages/scene-intelligence/src/keyframe-planner/index.js";
import type {
  ImageCapabilityProfile,
} from "../../packages/scene-intelligence/src/storyboard/index.js";
import type {
  ReferenceCapability,
} from "../../packages/scene-intelligence/src/reference-budget/index.js";
import type {
  PlannedScene,
} from "../../packages/scene-intelligence/src/shot-planner/index.js";
import {
  AGNES_IMAGE_2_1_FLASH,
  AGNES_VIDEO_2_5_FLASH,
} from "../../packages/capability-registry/src/data/agnes.js";

import {
  AgnesVideoSubmitter,
  AgnesVideoJobStoreSqlite,
  AgnesVideoBudgetDeclinedError,
} from "../../packages/providers/src/agnes/video/submit/index.js";
import type {
  AgnesVideoClient,
} from "../../packages/providers/src/agnes/video/submit/types.js";
import type {
  AgnesVideoSubmitInput,
} from "../../packages/providers/src/agnes/video/submit/request.js";
import {
  AgnesVideoPollRunner,
} from "../../packages/providers/src/agnes/video/poll/index.js";
import type {
  AgnesVideoTaskInfo,
} from "../../packages/providers/src/agnes/video/poll/types.js";
import {
  DialogueTtsRunner,
  deriveAssetId,
} from "../../packages/providers/src/fish-audio/tts/runner.js";
import type {
  AudioAssetStore,
  AudioByteStore,
  DialogueAudioAsset,
  DialogueLineInput,
  FishTtsSynthesizer,
  SynthesisRequest,
  SynthesisOutcome,
  TtsJobRecord,
  TtsJobStore,
} from "../../packages/providers/src/fish-audio/tts/types.js";

import {
  resumeEmergencyArchival,
} from "../../packages/media-storage/src/emergency-archival/emergency-archive.js";
import {
  EpisodeFolderEnsurer,
  EpisodeFolderStore,
  type EpisodeFoldersClient,
  type FindFoldersQuery,
  type CreateFolderInput,
  type GhlFolder,
} from "../../packages/media-storage/src/episode-folders/index.js";
import {
  GoHighLevelMediaStore,
} from "../../packages/media-storage/src/manifest/gohighlevel-media-store.js";

// ---------------------------------------------------------------------------
// Capability profiles (fixture-shaped, from the checked-in capability seed —
// same derivation examples/demo-series/fixtures.ts uses; the script owns its
// own copy so it has no example-dir dependency).
// ---------------------------------------------------------------------------

const NOW = "2026-08-29T00:00:00.000Z";
const CODE = "S01E01";

const DEMO_VIDEO_MODEL = {
  provider: AGNES_VIDEO_2_5_FLASH.provider,
  modelId: AGNES_VIDEO_2_5_FLASH.modelId,
  minDurationSeconds: AGNES_VIDEO_2_5_FLASH.output.minDurationSeconds ?? null,
  maxDurationSeconds: AGNES_VIDEO_2_5_FLASH.output.maxDurationSeconds ?? null,
  pricing: AGNES_VIDEO_2_5_FLASH.pricing,
} as const;

const DEMO_KEYFRAME_PROFILE: KeyframeCapabilityProfile = {
  firstFrame: AGNES_VIDEO_2_5_FLASH.references.firstFrame,
  lastFrame: AGNES_VIDEO_2_5_FLASH.references.lastFrame,
  firstLastFrame: AGNES_VIDEO_2_5_FLASH.references.firstLastFrame,
  multimodalReferences: AGNES_VIDEO_2_5_FLASH.references.multimodalReferences,
  maxImages: AGNES_VIDEO_2_5_FLASH.references.maxImages,
};

const DEMO_REFERENCE_CAPABILITY: ReferenceCapability = {
  maxImages: AGNES_VIDEO_2_5_FLASH.references.maxImages,
  firstFrame: AGNES_VIDEO_2_5_FLASH.references.firstFrame,
  lastFrame: AGNES_VIDEO_2_5_FLASH.references.lastFrame,
  firstLastFrame: AGNES_VIDEO_2_5_FLASH.references.firstLastFrame,
  multimodalReferences: AGNES_VIDEO_2_5_FLASH.references.multimodalReferences,
  allowedReferenceTypes: null,
  incompatibleCombinations: AGNES_VIDEO_2_5_FLASH.references.incompatibleCombinations,
};

const DEMO_IMAGE_PROFILE: ImageCapabilityProfile = {
  provider: AGNES_IMAGE_2_1_FLASH.provider,
  modelId: AGNES_IMAGE_2_1_FLASH.modelId,
  aspectRatios: AGNES_IMAGE_2_1_FLASH.output.aspectRatios,
  resolutions: AGNES_IMAGE_2_1_FLASH.output.resolutions,
  maxImages: AGNES_IMAGE_2_1_FLASH.references.maxImages,
  hardMaxCharacters: AGNES_IMAGE_2_1_FLASH.prompt.hardMaxCharacters,
  recommendedMaxCharacters: AGNES_IMAGE_2_1_FLASH.prompt.recommendedMaxCharacters,
  multimodalReferences: AGNES_IMAGE_2_1_FLASH.references.multimodalReferences,
  confidence: AGNES_IMAGE_2_1_FLASH.confidence,
};

// ---------------------------------------------------------------------------
// Controlled short sample — two scenes, 54 planned seconds (spec §30: short,
// deterministic, non-prod). Every beat carries an explicit durationHint so
// the shot planner's Agnes 4–12s window is satisfied with no empty shots.
// Story text is UNTRUSTED DATA: it is stored verbatim into record fields and
// never parsed for instructions nor executed (spec §29).
// ---------------------------------------------------------------------------

const DEMO_INTAKE = {
  intakeId: "idea_demo000000000000000000000000000000",
  rawText:
    "Mona, a night-shift library cat, finds a brass key that opens a door " +
    "between the library's shelves. Behind it: the Overdue Room, where every " +
    "book ever lost waits to be finished. Her keeper Juno has lost one story " +
    "Mona loved — with the library closing forever at dawn, Mona has one " +
    "night to bring it back.",
  aspectRatio: "16:9",
  targetRuntimeSeconds: 300,
  seriesLink: null,
  createdAt: NOW,
} as const;

const DEMO_CONCEPT_RESPONSE_BODY = {
  options: [
    {
      title: "The Overdue Room",
      logline:
        "A library cat must return a lost story before the library closes forever at dawn.",
      premise:
        "When Mona finds a brass key that opens a door between the shelves, she " +
        "discovers the Overdue Room — where every lost book waits to be finished. " +
        "Juno has lost the one story Mona loved, and demolition starts at dawn. " +
        "Mona recruits the room's resident ink-blot to rewrite the ending, and " +
        "learns that some stories only finish themselves when read aloud.",
      genre: "Family fantasy",
      tone: "cozy, moonlit wonder",
      visualStyle: "warm lamplight, dusty sunbeams, ink-and-paper textures",
      standoutMoments: [
        "the brass key turns between shelves",
        "the ink-blot signs the last page",
        "dawn light hits the 'CLOSED' sign",
      ],
      risks: ["night-time lamp-position continuity", "ink-blot shape consistency"],
      recommended: true,
      suggestedRuntimeSeconds: null,
      suggestedAspectRatio: null,
      suggestedEpisodeCount: 3,
    },
    {
      title: "Dewey Decimates",
      logline:
        "A library cat accidentally awakens the Dewey decimal system as a golem.",
      premise:
        "Mona's midnight yawn shatters the card catalog into a numbering golem " +
        "that reorganizes the whole town. To undo it she must file herself back " +
        "into the drawer she was born in.",
      genre: "Comedy",
      tone: "slapstick",
      visualStyle: "cardboard diorama",
      standoutMoments: ["the catalog avalanche"],
      risks: [],
      recommended: false,
      suggestedRuntimeSeconds: 240,
      suggestedAspectRatio: "9:16",
      suggestedEpisodeCount: null,
    },
  ],
  modelNotes: "Both options support the 3-episode demo arc.",
} as const;

const DEMO_SCREENPLAY = `TITLE: Mona & the Brass Key — S01E01 "The Overdue Room"

INT. HOLLOW PINE LIBRARY - READING ROOM - NIGHT

Moonlight stripes the empty reading room. MONA, a small grey
library cat, pads between the shelves. JUNO, the night librarian,
closes a ledger at the front desk.

MONA
(soft)
One more round, Juno. Then breakfast.

JUNO
Last round, Mona. Then lights out.

Mona's paw brushes a loose floorboard. A tarnished BRASS KEY
slides free and glints under the lamp.

MONA
(startled)
You were under the floor all along?

The bookcase behind her exhales dust. Somewhere deep in the
stacks, a door unlocks itself.

INT. HOLLOW PINE LIBRARY - THE OVERDUE ROOM - CONTINUOUS

The door opens onto a vast room of floating bookshelves. Every
book hovers with a small glowing date stamp. The ink-blot SMUDGE
peels off the floor and bows.

SMUDGE
You brought the key back. Took you nine years.

MONA
I want the story Juno lost. "The Cartographer's Daughter."

SMUDGE
(stacking himself into an arrow)
Then follow me, cat. But the room only keeps what is read aloud.

Mona steps onto a floating shelf. The door begins to swing shut
behind her — dawn edges creeps under it.
`;

const DEMO_KNOWN_CHARACTERS = ["MONA", "JUNO", "SMUDGE"] as const;

const CHAR = {
  mona: {
    characterId: "CHAR_DEMO_MONA_001",
    identityVersion: "mona-identity-v1",
    hairVersion: "mona-fur-v1",
    wardrobeVersion: "mona-collar-v1",
  },
  juno: {
    characterId: "CHAR_DEMO_JUNO_002",
    identityVersion: "juno-identity-v1",
    wardrobeVersion: "juno-cardigan-v1",
  },
  smudge: {
    characterId: "CHAR_DEMO_SMUDGE_003",
    identityVersion: "smudge-identity-v1",
    wardrobeVersion: "smudge-ink-v1",
  },
} as const;

const DEMO_PLANNED_SCENES: readonly PlannedScene[] = [
  {
    sceneId: "SC01",
    title: "Reading Room — Night",
    location: "LOC_LIBRARY_READING_ROOM",
    durationSeconds: 30,
    characters: [CHAR.mona, CHAR.juno],
    wardrobe: {
      [CHAR.mona.characterId]: CHAR.mona.wardrobeVersion,
      [CHAR.juno.characterId]: CHAR.juno.wardrobeVersion,
    },
    lighting: "moonlight stripes, warm desk lamp",
    props: ["brass key", "ledger"],
    timeOfDay: "night",
    beats: [
      {
        id: "SC01-B01",
        type: "establishing",
        description: "Moonlight stripes the empty reading room; Mona pads between the shelves.",
        characters: [CHAR.mona.characterId],
        durationHintSeconds: 6,
      },
      {
        id: "SC01-B02",
        type: "dialogue",
        description: "Mona checks in with Juno before the last round.",
        characters: [CHAR.mona.characterId, CHAR.juno.characterId],
        dialogue: [
          { characterId: CHAR.mona.characterId, text: "One more round, Juno. Then breakfast." },
          { characterId: CHAR.juno.characterId, text: "Last round, Mona. Then lights out." },
        ],
        durationHintSeconds: 8,
      },
      {
        id: "SC01-B03",
        type: "action",
        description: "Mona's paw brushes a loose floorboard; a brass key slides free and glints.",
        characters: [CHAR.mona.characterId],
        props: ["brass key"],
        durationHintSeconds: 6,
      },
      {
        id: "SC01-B04",
        type: "dialogue",
        description: "Mona startles at the key.",
        characters: [CHAR.mona.characterId],
        dialogue: [
          { characterId: CHAR.mona.characterId, text: "You were under the floor all along?" },
        ],
        durationHintSeconds: 4,
      },
      {
        id: "SC01-B05",
        type: "reaction",
        description: "The bookcase exhales dust; Mona's ears pin back.",
        characters: [CHAR.mona.characterId],
        emotion: "startled",
        durationHintSeconds: 3,
      },
      {
        id: "SC01-B06",
        type: "emotional",
        description: "Deep in the stacks, a door unlocks itself; Mona steps toward it.",
        characters: [CHAR.mona.characterId],
        durationHintSeconds: 3,
      },
    ],
  },
  {
    sceneId: "SC02",
    title: "The Overdue Room — Continuous",
    location: "LOC_LIBRARY_OVERDUE_ROOM",
    durationSeconds: 24,
    characters: [CHAR.mona, CHAR.smudge],
    wardrobe: {
      [CHAR.mona.characterId]: CHAR.mona.wardrobeVersion,
      [CHAR.smudge.characterId]: CHAR.smudge.wardrobeVersion,
    },
    lighting: "floating shelf-glow, cool key light",
    props: ["brass key", "the Cartographer's Daughter"],
    timeOfDay: "night",
    beats: [
      {
        id: "SC02-B01",
        type: "establishing",
        description: "The door opens onto floating bookshelves, every book with a glowing date stamp.",
        characters: [CHAR.mona.characterId],
        durationHintSeconds: 6,
      },
      {
        id: "SC02-B02",
        type: "dialogue",
        description: "Smudge bows and greets Mona; she names the story she came for.",
        characters: [CHAR.mona.characterId, CHAR.smudge.characterId],
        dialogue: [
          { characterId: CHAR.smudge.characterId, text: "You brought the key back. Took you nine years." },
          { characterId: CHAR.mona.characterId, text: "I want the story Juno lost." },
        ],
        durationHintSeconds: 8,
      },
      {
        id: "SC02-B03",
        type: "action",
        description: "Smudge stacks himself into an arrow pointing deeper into the room.",
        characters: [CHAR.smudge.characterId],
        durationHintSeconds: 4,
      },
      {
        id: "SC02-B04",
        type: "emotional",
        description: "Mona steps onto a floating shelf; the door begins to swing shut as dawn creeps under it.",
        characters: [CHAR.mona.characterId],
        emotion: "determined",
        durationHintSeconds: 6,
      },
    ],
  },
];

const DEMO_SCENE_MASTER_INPUTS = [
  {
    sceneId: "SC01",
    characters: [CHAR.mona.characterId, CHAR.juno.characterId],
    speakingCharacters: [CHAR.mona.characterId, CHAR.juno.characterId],
    importance: "high" as const,
  },
  {
    sceneId: "SC02",
    characters: [CHAR.mona.characterId, CHAR.smudge.characterId],
    speakingCharacters: [CHAR.smudge.characterId],
    importance: "hero" as const,
  },
];

/** Deterministic canon-at-the-time appearance resolver (demo cast). */
function resolveAppearance(characterId: string) {
  if (characterId === CHAR.mona.characterId) {
    return {
      identityVersion: CHAR.mona.identityVersion,
      hairVersion: CHAR.mona.hairVersion,
      wardrobeVersion: CHAR.mona.wardrobeVersion,
    };
  }
  if (characterId === CHAR.juno.characterId) {
    return {
      identityVersion: CHAR.juno.identityVersion,
      wardrobeVersion: CHAR.juno.wardrobeVersion,
    };
  }
  if (characterId === CHAR.smudge.characterId) {
    return {
      identityVersion: CHAR.smudge.identityVersion,
      wardrobeVersion: CHAR.smudge.wardrobeVersion,
    };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Framework: steps, scenarios, aggregate — same shape restart-sim.ts uses.
// ---------------------------------------------------------------------------

export interface ScenarioStep {
  name: string;
  ok: boolean;
  evidence: string;
}

export interface ScenarioResult {
  scenario: string;
  ok: boolean;
  steps: ScenarioStep[];
}

export interface E2eDryRunResult {
  ok: boolean;
  scenarios: ScenarioResult[];
  scratchRoot: string;
  /** The generated markdown report body (written to docs when --markdown). */
  markdown: string;
}

function ok(name: string, evidence: string): ScenarioStep {
  return { name, ok: true, evidence };
}
function fail(name: string, evidence: string): ScenarioStep {
  return { name, ok: false, evidence };
}
function assert(cond: boolean, name: string, evidence: string): ScenarioStep {
  return cond ? ok(name, evidence) : fail(name, evidence);
}

// ---------------------------------------------------------------------------
// Scripted fakes (the ONLY executable proxies: no network, no credentials, no
// spend; every one counts its calls so the evidence is measurable).
// ---------------------------------------------------------------------------

/** Agnes createVideo/getTask fake: deterministic video id + 2-poll completion. */
class ScriptedAgnesClient implements AgnesVideoClient {
  createCount = 0;
  getTasksFor = new Map<string, number>();
  createVideoArgs: unknown[] = [];

  async createVideo(request: unknown): Promise<{ videoId: string }> {
    this.createCount += 1;
    this.createVideoArgs.push(request);
    return { videoId: `agnes-video-${100000 + this.createCount}` };
  }

  async getTask(retrievalKey: string, _modelName?: string): Promise<AgnesVideoTaskInfo> {
    const n = (this.getTasksFor.get(retrievalKey) ?? 0) + 1;
    this.getTasksFor.set(retrievalKey, n);
    const done = n >= 2;
    return {
      status: done ? "completed" : "in_progress",
      seconds: "5",
      size: "720P",
      metadata: done ? { url: `https://agnes-mock.invalid/dl/${retrievalKey}.mp4` } : null,
    };
  }
}

/**
 * In-memory Agnes task store whose load() reads THROUGH a shared delegate
 * map. Two instances over the same map = two "processes" over one disk —
 * the restart boundary for the submit→kill→resume scenario. (The submit
 * side ALSO persists through AgnesVideoJobStoreSqlite into the scratch
 * SQLite, so the durable record genuinely crosses a DB boundary.)
 */
class SharedMapAgnesStore {
  constructor(private readonly map: Map<string, unknown>) {}
  async load(ref: string): Promise<unknown> {
    const raw = this.map.get(ref);
    return raw === undefined ? undefined : JSON.parse(raw as string);
  }
  async save(record: unknown): Promise<void> {
    const withRef = record as { ref: string };
    this.map.set(withRef.ref, JSON.stringify(record));
  }
}

/** Fish TTS synthesizer fake: deterministic bytes, counts synthesize calls. */
class ScriptedFishSynthesizer implements FishTtsSynthesizer {
  synthesizeCount = 0;
  async synthesize(request: SynthesisRequest): Promise<SynthesisOutcome> {
    this.synthesizeCount += 1;
    const bytes = new TextEncoder().encode(
      `fake-mp3-bytes for ${request.characterId}: ${request.text}`,
    );
    return {
      ok: true,
      audio: bytes,
      providerTaskId: `fish-${this.synthesizeCount}`,
      providerModel: "fish-tts-mock",
      durationSec: 2.4,
      cost: 0,
    };
  }
}

/** Shared in-memory TTS stores (job/asset/bytes ports from FISH-003 types). */
class MapTtsJobStore implements TtsJobStore {
  private readonly map = new Map<string, TtsJobRecord>();
  async load(ref: string): Promise<TtsJobRecord | undefined> {
    return this.map.get(ref);
  }
  async save(record: TtsJobRecord): Promise<void> {
    this.map.set(record.ref, record);
  }
}
class MapAudioAssetStore implements AudioAssetStore {
  private readonly map = new Map<string, DialogueAudioAsset>();
  async load(assetId: string) {
    return this.map.get(assetId);
  }
  async save(asset: DialogueAudioAsset): Promise<void> {
    this.map.set(asset.assetId, asset);
  }
}
class MapAudioByteStore implements AudioByteStore {
  private readonly map = new Map<string, Uint8Array>();
  async load(assetId: string) {
    return this.map.get(assetId);
  }
  async save(assetId: string, bytes: Uint8Array): Promise<void> {
    this.map.set(assetId, bytes);
  }
}

/** Counting fake GHL folder client (search-before-create is observable). */
class CountingFolderClient implements EpisodeFoldersClient {
  findCount = 0;
  createCount = 0;
  createdNames: string[] = [];
  async findFolders(_query: FindFoldersQuery): Promise<GhlFolder[]> {
    this.findCount += 1;
    return []; // empty tree: the ensurer must search first, then create
  }
  async createFolder(input: CreateFolderInput): Promise<GhlFolder> {
    this.createCount += 1;
    this.createdNames.push(input.name);
    return {
      id: `fld_${this.createCount.toString().padStart(3, "0")}`,
      name: input.name,
      parentId: input.parentId,
    };
  }
}

/** Fake hosted ingest + reachability probe (emergency archival + media store). */
class ScriptedIngest {
  archivedCount = 0;
  requests: { fileUrl?: string; name: string; parentId: string }[] = [];
  async archiveHosted(request: {
    fileUrl?: string;
    name: string;
    parentId: string;
    altId?: string;
  }): Promise<{ status: "ARCHIVED"; fileId: string; url: string; name: string }> {
    if (request.fileUrl === undefined) {
      throw new Error("hosted ingest: fileUrl required");
    }
    this.archivedCount += 1;
    this.requests.push({
      fileUrl: request.fileUrl,
      name: request.name,
      parentId: request.parentId,
    });
    return {
      status: "ARCHIVED",
      fileId: `ghl_file_${this.archivedCount}`,
      url: `https://storage.mock-ghl.invalid/${request.parentId}/${request.name}.mp4`,
      name: request.name,
    };
  }
  async mediaUpload(request: {
    fileUrl?: string;
    name: string;
    parentId: string;
    altId?: string;
    altType?: "location" | "agency";
  }): Promise<{ fileId: string; url: string; name?: string }> {
    const r = await this.archiveHosted(request);
    return { fileId: r.fileId, url: r.url, name: r.name };
  }
}

/**
 * AgnesVideoBudgetGate backed by the REAL CostLedger (spec §4): reserve maps
 * to a paid-kind ledger reservation; release marks it released. A ledger
 * `requires_approval` decision throws AgnesVideoBudgetDeclinedError — the
 * same contract the real gate port encodes (decline = throw; submitter
 * persists REJECTED and rethrows).
 */
class CostLedgerBudgetGate {
  reserved: { ref: string; estimatedCostUsd: number; id: string }[] = [];
  released: { id: string; reason: string }[] = [];
  constructor(
    private readonly ledger: CostLedger,
    private readonly episodeId: string,
  ) {}
  async reserve(request: {
    ref: string;
    provider: string;
    model: string;
    estimatedCostUsd: number;
    currency: "USD";
  }): Promise<{ id: string; release(reason: "submitted" | "failed"): Promise<void> }> {
    const decision = this.ledger.reserve({
      provider: "agnes",
      providerModel: request.model,
      estimatedUsd: request.estimatedCostUsd,
      kind: "paid",
      jobId: request.ref,
      episodeId: this.episodeId,
    });
    if (decision.outcome === "requires_approval") {
      // Spec §4: nothing reserved; the submitter persists REJECTED and stops.
      throw new AgnesVideoBudgetDeclinedError(request.ref, request.estimatedCostUsd);
    }
    const reservation = decision.reservation;
    this.reserved.push({
      ref: request.ref,
      estimatedCostUsd: request.estimatedCostUsd,
      id: reservation.id,
    });
    const released = this.released;
    return {
      id: reservation.id,
      async release(reason: "submitted" | "failed"): Promise<void> {
        // The dry run incurs no real spend: the hold is settled as released
        // (the live path would commit actuals via cost reconciliation). The
        // ledger row stays visible to the spend summary either way.
        released.push({ id: reservation.id, reason });
      },
    };
  }
  async releaseById(reservationId: string, reason: "submitted" | "failed"): Promise<void> {
    this.ledger.release(reservationId, reason === "submitted" ? "settled" : "aborted");
  }
}
