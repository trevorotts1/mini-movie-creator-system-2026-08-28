import { countWords, roundSeconds, validateOptions, validateScreenplayInput } from "./count-words.js";
import { DEFAULT_RUNTIME_ESTIMATOR_OPTIONS, ESTIMATOR_VERSION } from "./defaults.js";
import {
  RUNTIME_ESTIMATOR_INPUT_VERSION,
  type ResolvedRuntimeEstimatorOptions,
  type RuntimeEstimate,
  type RuntimeEstimatorOptions,
  type SceneEstimate,
  type ScreenplayInput,
} from "./types.js";

/**
 * Runtime estimator (spec §7 — "estimate scene duration"; spec §24 `mmcs
 * estimate`; spec §4 doctrine: derive cost/state BEFORE spending). Converts
 * a structured screenplay into per-scene and total runtime estimates by
 * word-count pacing. Story text is untrusted data — it is only counted,
 * never interpreted (spec §29).
 */

function resolveOptions(options?: RuntimeEstimatorOptions): ResolvedRuntimeEstimatorOptions {
  // Merge per-field with `??`, never by spread: an options object carrying an
  // explicitly-`undefined` key (`{ dialogueWordsPerSecond: undefined }`) would
  // clobber the default with `undefined` under spread and yield NaN runtimes,
  // while `validateOptions` (which skips undefined keys) would never object.
  const merged: Required<RuntimeEstimatorOptions> = {
    dialogueWordsPerSecond:
      options?.dialogueWordsPerSecond ?? DEFAULT_RUNTIME_ESTIMATOR_OPTIONS.dialogueWordsPerSecond,
    actionWordsPerSecond:
      options?.actionWordsPerSecond ?? DEFAULT_RUNTIME_ESTIMATOR_OPTIONS.actionWordsPerSecond,
    sceneOverheadSeconds:
      options?.sceneOverheadSeconds ?? DEFAULT_RUNTIME_ESTIMATOR_OPTIONS.sceneOverheadSeconds,
    minSceneSeconds: options?.minSceneSeconds ?? DEFAULT_RUNTIME_ESTIMATOR_OPTIONS.minSceneSeconds,
  };
  validateOptions(merged);
  return merged;
}

/**
 * Estimate one scene's runtime. Exported for planners that need a
 * single-scene projection (e.g. shot planning on one beat).
 */
export function estimateScene(
  scene: ScreenplayInput["scenes"][number],
  sceneIndex: number,
  options: ResolvedRuntimeEstimatorOptions,
): SceneEstimate {
  let dialogueWords = 0;
  let actionWords = 0;
  for (const element of scene.elements) {
    if (element.kind === "dialogue") {
      dialogueWords += countWords(element.text);
    } else {
      actionWords += countWords(element.text);
    }
  }

  const dialogueSeconds = roundSeconds(dialogueWords / options.dialogueWordsPerSecond);
  const actionSeconds = roundSeconds(actionWords / options.actionWordsPerSecond);
  const raw = dialogueSeconds + actionSeconds + options.sceneOverheadSeconds;
  const estimatedSeconds = roundSeconds(Math.max(raw, options.minSceneSeconds));

  return {
    sceneIndex,
    sceneId: scene.id,
    sceneTitle: scene.title ?? scene.id,
    dialogueWords,
    actionWords,
    dialogueSeconds,
    actionSeconds,
    overheadSeconds: options.sceneOverheadSeconds,
    estimatedSeconds,
  };
}

/**
 * Estimate the runtime of a structured screenplay. Throws
 * `RuntimeEstimatorError` on structurally invalid input or options.
 */
export function estimateRuntime(
  screenplay: ScreenplayInput,
  options?: RuntimeEstimatorOptions,
): RuntimeEstimate {
  validateScreenplayInput(screenplay);
  const resolved = resolveOptions(options);

  const perScene = screenplay.scenes.map((scene, sceneIndex) =>
    estimateScene(scene, sceneIndex, resolved),
  );

  // Sum the already-rounded per-scene values so the total is exactly the
  // sum a consumer recomputes from `perScene` — never a float-drift value.
  const totalSeconds = roundSeconds(
    perScene.reduce((sum, scene) => sum + scene.estimatedSeconds, 0),
  );

  return {
    screenplayId: screenplay.id,
    screenplayTitle: screenplay.title ?? screenplay.id,
    totalSeconds,
    perScene,
    estimatorVersion: ESTIMATOR_VERSION,
    inputVersion: RUNTIME_ESTIMATOR_INPUT_VERSION,
    options: resolved,
    estimatedAt: new Date().toISOString(),
  };
}

/**
 * Validate a persisted estimate against the current estimator shape.
 * Tolerant on provenance (estimatedAt/version strings) — strict on numbers.
 */
export function isValidRuntimeEstimate(value: unknown): value is RuntimeEstimate {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const v = value as Partial<RuntimeEstimate>;
  const validNumber = (n: unknown): n is number =>
    typeof n === "number" && Number.isFinite(n) && n >= 0;
  return (
    typeof v.screenplayId === "string" &&
    validNumber(v.totalSeconds) &&
    Array.isArray(v.perScene) &&
    v.perScene.every(
      (scene) =>
        typeof scene?.sceneId === "string" &&
        validNumber(scene.estimatedSeconds),
    )
  );
}