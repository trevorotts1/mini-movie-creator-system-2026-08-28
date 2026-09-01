/**
 * Mocked vision model for identity-QC tests and offline dry runs — QC-002.
 *
 * The production vision adapter (OpenRouter-compatible) is a separate concern;
 * everything in `packages/qc/src/identity` runs against the `VisionModel`
 * interface, so tests inject a mock that replays scripted comparisons. This
 * mock records the prompts/images it received so tests can assert the
 * canonical identity asset and the extracted frame were actually sent.
 */

import type {
  VisionAttribute,
  VisionComparison,
  VisionImage,
  VisionModel,
} from "./identity.js";

/** One scripted response in the mock's replay queue. */
export interface MockVisionResponse {
  verdict: VisionComparison["verdict"];
  confidence: number;
  rationale?: string;
  /** Per-attribute entries; defaulted to all-match when omitted. */
  attributes?: VisionAttribute[];
}

/** A recorded vision-model call (what the test asserts against). */
export interface RecordedVisionCall {
  prompt: string;
  reference: VisionImage;
  candidate: VisionImage;
}

/** Replay-scripted VisionModel. Each call pops the next scripted response. */
export class MockVisionModel implements VisionModel {
  readonly modelId: string;

  /** Scripted responses; the last one repeats once the queue drains. */
  readonly responses: MockVisionResponse[];

  /** Every call made against this mock, in order. */
  readonly calls: RecordedVisionCall[] = [];

  constructor(modelId: string, responses: MockVisionResponse[]) {
    if (responses.length === 0) {
      throw new Error("MockVisionModel requires at least one scripted response");
    }
    this.modelId = modelId;
    this.responses = responses;
  }

  async compareImages(
    prompt: string,
    reference: VisionImage,
    candidate: VisionImage,
  ): Promise<VisionComparison> {
    this.calls.push({ prompt, reference, candidate });
    const index = Math.min(this.calls.length - 1, this.responses.length - 1);
    const scripted = this.responses[index];
    if (!scripted) {
      throw new Error("MockVisionModel: unresolvable scripted response");
    }
    return {
      verdict: scripted.verdict,
      confidence: scripted.confidence,
      rationale: scripted.rationale ?? "mock",
      attributes: scripted.attributes ?? [],
    };
  }
}