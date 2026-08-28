/// <reference types="node" />
/**
 * FISH-003 — TTS generation types.
 *
 * Spec §30 / runbook §36/§38 contract: dialogue is synthesized as a SEPARATE
 * durable audio asset — replacing a video clip never forces voice
 * regeneration. Job records are persisted BEFORE the synthesis call (runbook
 * §21: persist provider task/job ID before polling; for Fish's synchronous
 * POST /v1/tts the "poll" is the single awaited HTTP call, so the record hits
 * the store first, then synthesis runs, then the result is persisted).
 *
 * Ownership boundaries (zero path overlap):
 *   - FISH-001 owns the HTTP client (../client) — wired in as the synthesizer.
 *   - FISH-002 owns voice profiles (../voice-profiles) — callers resolve the
 *     voiceId from a profile before calling the runner.
 *   - FISH-004 owns pronunciation rewriting — applied upstream; the text this
 *     module receives is already TTS-ready, and the ORIGINAL text is carried
 *     separately for captions (FISH-006/007).
 *   - FISH-005 owns the durable dialogue cache — this module defines the
 *     `DialogueCachePort` seam it implements; dedupe by requestHash is
 *     optional here and mandatory there.
 *   - GHL archival (WF07) owns everything after GENERATED_TEMPORARY.
 */

/** Full pipeline job-state machine (runbook §21). */
export type FishPipelineState =
  | "PLANNED"
  | "BUDGET_RESERVED"
  | "SUBMITTING"
  | "SUBMITTED"
  | "GENERATING"
  | "GENERATED_TEMPORARY"
  | "ARCHIVING"
  | "ARCHIVED"
  | "QC_PENDING"
  | "QC_FIXING"
  | "APPROVED"
  | "REJECTED";

/** Terminal states for the TTS generation step (archival/QC own the rest). */
export const TTS_TERMINAL_STATES: ReadonlySet<FishPipelineState> = new Set([
  "GENERATED_TEMPORARY",
  "REJECTED",
]);

/** True when the TTS generation step may stop at this state. */
export function isTtsTerminal(state: FishPipelineState): boolean {
  return TTS_TERMINAL_STATES.has(state);
}

/** One line of dialogue to synthesize. Text is UNTRUSTED input: it is only
 * ever placed into JSON request bodies, never executed or eval'd. */
export interface DialogueLineInput {
  /** Stable MMCS character ID (CHAR_*_001 style) the line belongs to. */
  characterId: string;
  /** Fish voice/reference ID to synthesize with (from the FISH-002 profile). */
  voiceId: string;
  /** The text to speak (post-pronunciation-rewrite when FISH-004 is wired). */
  text: string;
  /** Original script text for captions/alignment; defaults to `text`. */
  originalText?: string;
  /** Fish model ID; config-driven (FISH-010), never inlined at call sites. */
  model?: string;
  /** Audio format for the returned bytes. Default: "mp3". */
  format?: "wav" | "pcm" | "mp3" | "opus";
  /** Extra synthesis settings (prosody, temperature, …) passed through. */
  settings?: Record<string, unknown>;
  /** Series/episode/scene/shot placement metadata for the asset record. */
  seriesId?: string;
  episodeId?: string;
  sceneId?: string;
  shotId?: string;
  /** Character version the voice profile was locked at. */
  characterVersion?: string;
}

/**
 * Durable TTS job record (runbook §38 fields for one provider job). Persisted
 * BEFORE synthesis; the `requestHash` is the idempotency identifier. Fish's
 * /v1/tts is synchronous and returns no server task ID — per §38 the
 * request-hash identifier stands in as `providerTaskId` unless the provider
 * supplies one.
 */
export interface TtsJobRecord {
  /** Business reference, e.g. "ep01:sc03:shot12:line2". Unique per store. */
  ref: string;
  /** Current §21 state. */
  state: FishPipelineState;
  /** SHA-256 request hash — the idempotency identifier (runbook §38). */
  requestHash: string;
  /** Provider task/job ID when one exists; request-hash ID for sync TTS. */
  providerTaskId?: string;
  /** Fish model submitted with (config-driven). */
  model?: string;
  /** Character + voice the line was synthesized for. */
  characterId?: string;
  voiceId?: string;
  /** Submit-time snapshot for audit (text/voice/model/settings). */
  submitRequest?: {
    characterId: string;
    voiceId: string;
    text: string;
    model?: string;
    format?: string;
    settings?: Record<string, unknown>;
  };
  /** Asset produced on success. */
  assetId?: string;
  /** Failure detail when state is REJECTED. */
  failure?: TtsJobFailure;
  /** ISO-8601 timestamps. */
  createdAt: string;
  updatedAt: string;
}

/** Normalized failure carried on a REJECTED record. */
export interface TtsJobFailure {
  message: string;
  /** Fish error kind (FISH-001 taxonomy) when the failure came from the API. */
  kind?: string;
}

/**
 * Durable dialogue-audio asset (runbook §36 subset — the audio fields MMCS
 * owns at generation time). Deliberately INDEPENDENT of any video asset:
 * there is no video/clip binding field, so replacing a video never invalidates
 * or regenerates the voice (spec §30). GHL archival fields stay optional —
 * the archival layer (WF07) fills them and flips assetState to ARCHIVED.
 */
export interface DialogueAudioAsset {
  /** Stable asset ID: "da-<requestHash prefix>" — deterministic per request. */
  assetId: string;
  /** Always "dialogue_audio" — audio is its own asset class (spec §36). */
  assetType: "dialogue_audio";
  /** §21 asset state; starts GENERATED_TEMPORARY here. */
  assetState: FishPipelineState;
  /** Placement metadata (optional; not part of the idempotency hash). */
  seriesId?: string;
  episodeId?: string;
  sceneId?: string;
  shotId?: string;
  characterId: string;
  characterVersion?: string;
  /** Provider identity for provenance (spec §36). */
  provider: "fish-audio";
  providerModel?: string;
  /** Provider task/job ID persisted with the asset (runbook §36/§38). */
  providerTaskId?: string;
  /** SHA-256 hex checksum of the audio bytes. */
  checksum: string;
  /** Audio size in bytes. */
  byteLength: number;
  /** Audio container/format. */
  format: string;
  /** The dialogue job ref this asset was generated from. */
  dialogueRef: string;
  /** Original (pre-rewrite) text — captions/alignment consume this. */
  originalText: string;
  /** Spoken text actually sent to the provider. */
  spokenText: string;
  /** Duration in seconds when the provider reports it. */
  durationSec?: number;
  /** Generation settings snapshot (audit/provenance). */
  generationSettings?: Record<string, unknown>;
  /** Estimated/actual cost when known (cost engine owns accounting). */
  cost?: number;
  /** ISO-8601 timestamps. */
  createdAt: string;
  archivedAt?: string;
}

/** The bytes for a generated asset, paired with its durable record. */
export interface DialogueAudioResult {
  job: TtsJobRecord;
  asset: DialogueAudioAsset;
  /** Raw synthesized audio bytes (in-memory; durable copies go through the
   * asset store + the archival layer). */
  audio: Uint8Array;
  /** True when an existing asset was reused instead of resynthesized. */
  fromCache: boolean;
}

/** Durable store port for TTS job records. Implement over SQLite (CORE-007). */
export interface TtsJobStore {
  load(ref: string): Promise<TtsJobRecord | undefined>;
  save(record: TtsJobRecord): Promise<void>;
}

/** Durable store port for dialogue-audio asset records (metadata only). */
export interface AudioAssetStore {
  load(assetId: string): Promise<DialogueAudioAsset | undefined>;
  save(asset: DialogueAudioAsset): Promise<void>;
}

/**
 * Durable byte store for audio payloads. The metadata store above is the
 * asset's identity; this port holds the bytes (media-storage / local blob
 * layer). The runner writes bytes here on generation so a restart — or a new
 * runner instance over the same stores — can load them again without
 * resynthesis (runbook §21: resume, never resubmit).
 */
export interface AudioByteStore {
  load(assetId: string): Promise<Uint8Array | undefined>;
  save(assetId: string, bytes: Uint8Array): Promise<void>;
}

/**
 * Optional dedupe seam (FISH-005 implements the durable version). When a
 * cache hit returns an asset for the same requestHash, synthesis is skipped.
 */
export interface DialogueCachePort {
  /** Look up a previously generated asset id by request hash. */
  findAssetId(requestHash: string): Promise<string | undefined>;
  /** Remember an asset id under its request hash. */
  put(requestHash: string, assetId: string): Promise<void>;
}

/** Synthesis request the runner passes to the FISH-001-backed port. */
export interface SynthesisRequest {
  characterId: string;
  voiceId: string;
  text: string;
  model?: string;
  format: "wav" | "pcm" | "mp3" | "opus";
  settings?: Record<string, unknown>;
}

/** Synthesis outcome: bytes + provider identifiers, or a failure. */
export type SynthesisOutcome =
  | {
      ok: true;
      audio: Uint8Array;
      /** Provider task/job ID when the provider returns one. */
      providerTaskId?: string;
      providerModel?: string;
      providerUrl?: string;
      durationSec?: number;
      cost?: number;
    }
  | {
      ok: false;
      failure: { message: string; kind?: string };
    };

/**
 * The synthesis seam this module depends on. FISH-001's FishClient adapts to
 * this in production; tests mock it. Kept narrow on purpose — the runner must
 * never touch HTTP itself.
 */
export interface FishTtsSynthesizer {
  synthesize(request: SynthesisRequest): Promise<SynthesisOutcome>;
}

/** Options for the runner's injectable seams. */
export interface DialogueTtsRunnerOptions {
  /** Injectable clock (ISO string); defaults to Date-based. */
  now?: () => string;
  /** Injectable random id source for asset ids; defaults to a counter-free
   * deterministic derivation (asset ids are request-hash derived anyway). */
  makeId?: () => string;
  /** Durable byte store (runbook §21: resume, never resubmit). Generated
   * bytes are persisted through it so a restart — or a new runner instance
   * over the same stores — reloads them without resynthesis. */
  bytes?: AudioByteStore;
}