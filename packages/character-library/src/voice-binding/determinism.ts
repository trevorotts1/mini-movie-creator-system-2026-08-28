/**
 * Voice-binding determinism (spec §30): "Recurring characters never randomly
 * change voices across episodes."
 *
 * The binding is deterministic by construction: a character's synthesis
 * parameters derive from the single stored `VoiceProfile` for that character
 * ID, never from a per-episode selection. Given the same store contents, every
 * episode resolves the exact same profile (same Fish voice/reference ID,
 * model, pace, emotion/style, pronunciation dictionary, proper nouns) for the
 * same character — so voice cannot drift randomly between episodes.
 *
 * Any voice change is an explicit `updateVoiceProfile` mutation that bumps
 * `version` and is auditable via the store — never an implicit re-roll.
 */
import {
  isProductionReady,
  type VoiceProfile,
} from "./profile.js";

/** The exact synthesis-relevant parameters a TTS request must use for a
 * character. Two episodes of the same character produce equal
 * `SynthesisBinding` values unless a voice profile was deliberately updated. */
export interface SynthesisBinding {
  characterId: string;
  fishVoiceId: string;
  model: string;
  pace: VoiceProfile["pace"];
  emotionStyle: string;
  /** Dictionary entries (term+pronunciation) in stored order — order-stable
   * so the binding hash is stable. */
  pronunciationDictionary: { term: string; pronunciation: string }[];
  /** Proper nouns in stored order. */
  importantProperNouns: string[];
  /** Profile version the binding was resolved from (audit trail). */
  version: number;
}

/** Resolve the deterministic synthesis binding for one character from a
 * profile map (the store's `profiles` document shape). Throws when no profile
 * exists for the character. Pure function: same input map, same output. */
export function resolveSynthesisBinding(
  profiles: Record<string, VoiceProfile>,
  characterId: string,
): SynthesisBinding {
  const profile = profiles[characterId];
  if (!profile) {
    throw new Error(
      `No voice profile bound to character ${characterId} — voice binding is required before synthesis`,
    );
  }
  return {
    characterId: profile.characterId,
    fishVoiceId: profile.fishVoiceId,
    model: profile.model,
    pace: profile.pace,
    emotionStyle: profile.emotionStyle,
    pronunciationDictionary: profile.pronunciationDictionary.map((p) => ({
      term: p.term,
      pronunciation: p.pronunciation,
    })),
    importantProperNouns: [...profile.importantProperNouns],
    version: profile.version,
  };
}

/** Resolve bindings for many characters (a cast list). Fails on the first
 * missing profile so a cast with an unbound character never silently
 * synthesizes with a wrong/default voice. */
export function resolveCastBindings(
  profiles: Record<string, VoiceProfile>,
  characterIds: readonly string[],
): SynthesisBinding[] {
  return characterIds.map((id) => resolveSynthesisBinding(profiles, id));
}

/** Stable JSON stringify: object keys sorted recursively so two deep-equal
 * values always serialize identically. Used for binding fingerprints. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`)
    .join(",")}}`;
}

/** Deterministic FNV-1a 32-bit fingerprint of a binding, hex-encoded.
 * Same binding → same fingerprint, across processes and episodes. Used as a
 * cheap drift check in QC/caption pipelines; not a security hash. */
export function bindingFingerprint(binding: SynthesisBinding): string {
  const text = stableStringify(binding);
  // FNV-1a 32-bit
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** Verify two bindings for the same character are identical — the determinism
 * check run when preparing a new episode's dialogue: a recurring character's
 * binding this episode must equal the binding used last episode (or the
 * recorded expected fingerprint). Returns the mismatch reason, or undefined
 * when identical. */
export function verifyVoiceStability(
  expected: SynthesisBinding,
  actual: SynthesisBinding,
): string | undefined {
  if (expected.characterId !== actual.characterId) {
    return `characterId mismatch: expected ${expected.characterId}, got ${actual.characterId}`;
  }
  if (expected.fishVoiceId !== actual.fishVoiceId) {
    return `fishVoiceId changed for ${actual.characterId}: ${expected.fishVoiceId} -> ${actual.fishVoiceId}`;
  }
  if (expected.model !== actual.model) {
    return `model changed for ${actual.characterId}: ${expected.model} -> ${actual.model}`;
  }
  if (expected.pace !== actual.pace) {
    return `pace changed for ${actual.characterId}: ${expected.pace} -> ${actual.pace}`;
  }
  if (expected.emotionStyle !== actual.emotionStyle) {
    return `emotionStyle changed for ${actual.characterId}: ${JSON.stringify(expected.emotionStyle)} -> ${JSON.stringify(actual.emotionStyle)}`;
  }
  if (
    stableStringify(expected.pronunciationDictionary) !==
    stableStringify(actual.pronunciationDictionary)
  ) {
    return `pronunciationDictionary changed for ${actual.characterId}`;
  }
  if (
    stableStringify(expected.importantProperNouns) !==
    stableStringify(actual.importantProperNouns)
  ) {
    return `importantProperNouns changed for ${actual.characterId}`;
  }
  return undefined;
}

export { isProductionReady };