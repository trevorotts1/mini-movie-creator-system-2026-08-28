/// <reference types="node" />
/**
 * FISH-003 — TTS generation public surface.
 *
 * Dialogue → durable dialogue_audio asset. The asset is separate from video
 * by construction (spec §30): no video binding field exists, so replacing a
 * video clip never forces voice regeneration.
 */
export type {
  AudioAssetStore,
  AudioByteStore,
  DialogueAudioAsset,
  DialogueAudioResult,
  DialogueCachePort,
  DialogueLineInput,
  DialogueTtsRunnerOptions,
  FishPipelineState,
  FishTtsSynthesizer,
  SynthesisOutcome,
  SynthesisRequest,
  TtsJobFailure,
  TtsJobRecord,
  TtsJobStore,
} from "./types.js";
export { isTtsTerminal, TTS_TERMINAL_STATES } from "./types.js";
export { hashDialogueRequest, stableStringify, type TtsHashInput } from "./hash.js";
export {
  deriveAssetId,
  DialogueTtsRunner,
  DialogueValidationError,
  sha256Hex,
  TtsSynthesisError,
  validateDialogueLine,
} from "./runner.js";
export { FishClientSynthesizer, synthesizeFailure } from "./synthesize.js";