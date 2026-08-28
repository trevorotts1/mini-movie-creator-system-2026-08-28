/**
 * Word counting + validation for the runtime estimator (spec §7).
 * Counting is the only operation ever applied to story text — it is
 * untrusted data (spec §29) and is never interpreted or executed.
 */

import {
  RuntimeEstimatorError,
  type ResolvedRuntimeEstimatorOptions,
  type ScreenplayElement,
  type ScreenplayInput,
} from "./types.js";

/** Screenplay element kinds accepted by the estimator. */
const ELEMENT_KINDS = new Set(["dialogue", "action"]);

/**
 * Count words in text: maximal runs of non-whitespace characters that
 * contain at least one letter or digit. Internal apostrophes ("don't",
 * "it's") keep one word together; bare punctuation marks ("...", "--")
 * are never counted.
 * Pure function — never evaluates the text content.
 */
export function countWords(text: string): number {
  let count = 0;
  for (const token of text.split(/\s+/u)) {
    if (token.length === 0) {
      continue;
    }
    // A word must contain a letter or digit; keep internal apostrophes
    // attached (don't) but reject bare punctuation tokens ("...", "--").
    if (/\p{L}|\p{N}/u.test(token)) {
      count += 1;
    }
  }
  return count;
}

/** Validate one element; returns a plain readable error message or null. */
function elementError(element: ScreenplayElement, index: number): string | null {
  if (element === null || typeof element !== "object") {
    return `elements[${index}] must be an object with kind and text`;
  }
  if (!ELEMENT_KINDS.has(element.kind)) {
    return `elements[${index}].kind must be "dialogue" or "action"`;
  }
  if (typeof element.text !== "string") {
    return `elements[${index}].text must be a string`;
  }
  return null;
}

/** Validate one scene; returns an error message or null. */
function sceneError(scene: unknown, index: number): string | null {
  if (scene === null || typeof scene !== "object") {
    return `scenes[${index}] must be an object with id and elements`;
  }
  const s = scene as Partial<ScreenplayInput["scenes"][number]>;
  if (typeof s.id !== "string" || s.id.trim() === "") {
    return `scenes[${index}].id must be a non-empty string`;
  }
  if (!Array.isArray(s.elements)) {
    return `scenes[${index}].elements must be an array`;
  }
  for (let i = 0; i < s.elements.length; i += 1) {
    const err = elementError(s.elements[i] as ScreenplayElement, i);
    if (err !== null) {
      return `scenes[${index}]: ${err}`;
    }
  }
  return null;
}

/** Validate a screenplay-shaped input; throws RuntimeEstimatorError on defects. */
export function validateScreenplayInput(input: unknown): asserts input is ScreenplayInput {
  if (input === null || typeof input !== "object") {
    throw new RuntimeEstimatorError("screenplay input must be an object with id and scenes");
  }
  const candidate = input as Partial<ScreenplayInput>;
  if (typeof candidate.id !== "string" || candidate.id.trim() === "") {
    throw new RuntimeEstimatorError("screenplay id must be a non-empty string");
  }
  if (!Array.isArray(candidate.scenes)) {
    throw new RuntimeEstimatorError("screenplay scenes must be an array");
  }
  for (let i = 0; i < candidate.scenes.length; i += 1) {
    const err = sceneError(candidate.scenes[i], i);
    if (err !== null) {
      throw new RuntimeEstimatorError(err);
    }
  }
}

/** Validate estimator options: every provided value must be finite and positive. */
export function validateOptions(values: {
  dialogueWordsPerSecond?: number;
  actionWordsPerSecond?: number;
  sceneOverheadSeconds?: number;
  minSceneSeconds?: number;
}): void {
  const checks: Array<[string, number | undefined, boolean]> = [
    ["dialogueWordsPerSecond", values.dialogueWordsPerSecond, true],
    ["actionWordsPerSecond", values.actionWordsPerSecond, true],
    ["sceneOverheadSeconds", values.sceneOverheadSeconds, false],
    ["minSceneSeconds", values.minSceneSeconds, false],
  ];
  for (const [name, value, requirePositive] of checks) {
    if (value === undefined) {
      continue;
    }
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new RuntimeEstimatorError(`${name} must be a finite number`);
    }
    if (requirePositive && value <= 0) {
      throw new RuntimeEstimatorError(`${name} must be positive`);
    }
    if (!requirePositive && value < 0) {
      throw new RuntimeEstimatorError(`${name} must be non-negative`);
    }
  }
}

/** Round seconds to two decimals so estimates are stable and persisted exactly. */
export function roundSeconds(seconds: number): number {
  return Math.round(seconds * 100) / 100;
}