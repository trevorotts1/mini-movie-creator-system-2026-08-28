/**
 * Fish Audio TTS request shaping with pronunciation support.
 *
 * FISH-004 contract: the per-character pronunciation dictionary and the
 * proper-noun list are APPLIED TO TTS REQUESTS — every request that goes to
 * Fish Audio /tts carries the rewritten text plus the dictionary version it
 * was built against, so runs are reproducible and auditable.
 */

import type { PronunciationDictionary } from "./dictionary.js";
import {
  applyPronunciation,
  type ApplyPronunciationOptions,
  type PronunciationApplication,
} from "./apply.js";

/** Voice assignment for one TTS request (FISH-002 owns voice profiles). */
export interface TtsVoiceRef {
  /** Fish Audio voice ID (or reference ID) from the character voice profile. */
  voiceId: string;
}

/** A single TTS request for the Fish Audio provider. */
export interface FishTtsRequest {
  /** Character the line belongs to (drives per-character dictionary). */
  characterId: string;
  /** The script text to speak — ORIGINAL text, never pre-rewritten. */
  text: string;
  /** Voice to synthesize with. */
  voice: TtsVoiceRef;
  /** Optional BCP-47 language tag for dictionary filtering. */
  language?: string;
  /** Optional model override; provider default otherwise (FISH-010 owns config). */
  model?: string;
}

/** The shaped request payload sent to the Fish Audio /tts endpoint. */
export interface FishTtsPayload {
  /** Rewritten text: pronunciation dictionary + proper nouns applied. */
  text: string;
  /** Fish voice/reference ID. */
  reference_id: string;
  /** Fish model, when pinned on the request. */
  model?: string;
}

/** A TTS request fully resolved for sending, with its pronunciation audit. */
export interface ResolvedFishTtsRequest {
  /** The exact payload to POST to Fish Audio /tts. */
  payload: FishTtsPayload;
  /** Original script text (captions/alignment must use this, not payload.text). */
  originalText: string;
  /** Pronunciation application record (which entries fired, dictionary version). */
  pronunciation: PronunciationApplication;
}

/** Shape a Fish Audio TTS request, applying the character's dictionary. */
export function resolveFishTtsRequest(
  request: FishTtsRequest,
  getDictionary: (characterId: string) => PronunciationDictionary | undefined,
  options: ApplyPronunciationOptions = {},
): ResolvedFishTtsRequest {
  if (!request || typeof request !== "object") {
    throw new Error("request is required");
  }
  if (typeof request.characterId !== "string" || request.characterId.trim() === "") {
    throw new Error("request.characterId is required");
  }
  if (typeof request.text !== "string") {
    throw new Error("request.text must be a string");
  }
  if (!request.voice || typeof request.voice.voiceId !== "string" || request.voice.voiceId.trim() === "") {
    throw new Error("request.voice.voiceId is required");
  }

  const dictionary = getDictionary(request.characterId);
  const language = options.language ?? request.language;
  const pronunciation = dictionary
    ? applyPronunciation(request.text, dictionary, { language })
    : {
        ttsText: request.text,
        originalText: request.text,
        dictionaryVersion: 0,
        characterId: request.characterId,
        applied: [],
        properNounsApplied: [],
      };

  const payload: FishTtsPayload = {
    text: pronunciation.ttsText,
    reference_id: request.voice.voiceId,
  };
  if (request.model !== undefined) {
    payload.model = request.model;
  }

  return {
    payload,
    originalText: request.text,
    pronunciation,
  };
}