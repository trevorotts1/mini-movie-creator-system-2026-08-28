/// <reference types="node" />
/**
 * FISH-003 — adapter from the FISH-001 FishClient to the narrow
 * {@link FishTtsSynthesizer} seam the runner consumes.
 *
 * Only transport-to-seam mapping lives here: bearer/model headers and binary
 * responses are the client's job (FISH-001); failure taxonomy is folded into
 * the runner's `{ok:false, failure}` shape. Text arrives as untrusted data
 * and leaves as a JSON body field — nothing else.
 */
import type { FishClient } from "../client/client.js";
import type { FishApiError } from "../client/errors.js";
import type {
  FishTtsSynthesizer,
  SynthesisOutcome,
  SynthesisRequest,
} from "./types.js";

/** Map the FISH-001 error taxonomy onto the runner's failure shape. */
export function synthesizeFailure(error: FishApiError): SynthesisOutcome {
  return {
    ok: false,
    failure: {
      message: error.message + (error.apiMsg ? `: ${error.apiMsg}` : ""),
      kind: error.kind,
    },
  };
}

/**
 * Adapt a FISH-001 FishClient to the synthesizer seam. One instance per
 * client; stateless between calls.
 */
export class FishClientSynthesizer implements FishTtsSynthesizer {
  constructor(private readonly client: FishClient) {}

  async synthesize(request: SynthesisRequest): Promise<SynthesisOutcome> {
    const model = request.model?.trim();
    if (!model) {
      // FISH-010 owns model config; the runner refuses to guess a model.
      return {
        ok: false,
        failure: {
          message: "Fish TTS model is required (engine config FISH_MODEL; never hardcoded)",
        },
      };
    }

    const result = await this.client.tts({
      text: request.text,
      referenceId: request.voiceId,
      model: model as Parameters<FishClient["tts"]>[0]["model"],
      format: request.format,
      ...((request.settings ?? {}) as Record<string, never>),
    });

    if (!result.ok) {
      return synthesizeFailure(result.error);
    }
    const audio = new Uint8Array(result.data);
    if (audio.byteLength === 0) {
      return {
        ok: false,
        failure: { message: "Fish Audio TTS returned zero bytes of audio" },
      };
    }
    return {
      ok: true,
      audio,
      providerModel: model,
    };
  }
}