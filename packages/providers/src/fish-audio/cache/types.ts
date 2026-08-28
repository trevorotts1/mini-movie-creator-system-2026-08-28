/**
 * Dialogue-cache data shapes (FISH-005).
 *
 * Runbook §30: "Dialogue generated as separate durable asset so replacing a
 * video clip does not force voice regeneration." The cache record IS that
 * durable asset: keyed by a request hash (see key.ts) so the same
 * text+voice+model+synthesis-parameters request always resolves to the same
 * stored audio — regenerating an episode never re-bills synthesis for dialogue
 * that was already generated.
 *
 * Story/dialogue text is UNTRUSTED data (spec §21): it is hashed and stored
 * verbatim, never evaluated, never interpolated into executable context.
 */

/** Which audio format the cached bytes were synthesized in. */
export type FishAudioFormat = "wav" | "pcm" | "mp3" | "opus";

/** The synthesis request a cache key was derived from (FISH-005 input). */
export interface FishDialogueRequest {
  /** The dialogue text to synthesize. Untrusted content — stored, never executed. */
  text: string;
  /** Voice model ID(s): string = single speaker; array = S2-family dialogue. */
  voiceId: string | string[];
  /** Fish TTS model (e.g. "s2-pro"). Config-driven; part of the key. */
  model: string;
  /** Output audio format. Part of the key. */
  format?: FishAudioFormat;
  /** Prosody overrides. Part of the key (normalized). */
  prosody?: { speed?: number; volume?: number };
  /** Sampling temperature. Part of the key. */
  temperature?: number;
  /** Top-p. Part of the key. */
  topP?: number;
  /** Audio sample rate in Hz. Part of the key. */
  sampleRate?: number;
}

/** The durable cached dialogue asset. One record per cache key. */
export interface FishDialogueCacheEntry {
  /** Versioned cache key: `fsh1:<versionPrefix><hex sha256>`. */
  key: string;
  /** The request that produced this entry (echoed for traceability). */
  request: FishDialogueRequest;
  /** Synthesized audio bytes. */
  audio: ArrayBuffer;
  /** Byte length of `audio`. */
  audioByteLength: number;
  /** Fish TTS model actually used (mirrors `request.model`). */
  model: string;
  /** ISO-8601 timestamp of when the audio was synthesized. */
  createdAt: string;
  /** Provenance: how this entry came to exist. */
  origin: "synthesized";
}

/** The on-disk document shape (one file per key). Versioned for evolution. */
export interface FishDialogueCacheFile {
  formatVersion: 1;
  entry: Omit<FishDialogueCacheEntry, "audio">;
  /** Base64 of the audio bytes. */
  audioBase64: string;
}