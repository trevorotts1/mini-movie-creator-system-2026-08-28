/// <reference types="node" />
import { describe, expect, expectTypeOf, it } from "vitest";

import {
  IDENTITY_FAILURE_CLASS,
  SEEDANCE_FALLBACK_DURATION,
  buildSeedanceFallback,
  routeSeedanceFallback,
  shouldEscalateToSeedance,
  type EscalationHistory,
  type PersistingFailureClass,
  type QcOutcome,
  type SeedanceFallbackShot,
} from "./index.js";
import { SEEDANCE_2_MINI_MODEL } from "@mmcs/providers/kie/seedance/seedance.js";

const IDENTITY_FAIL: QcOutcome = {
  status: "FAIL",
  failures: [{ failureClass: IDENTITY_FAILURE_CLASS, detail: "face drifts off-model" }],
};
const COST_FAIL: QcOutcome = {
  status: "FAIL",
  failures: [{ failureClass: "provider-timeout" }],
};
const PASS: QcOutcome = { status: "PASS", failures: [] };

const BOTH_STAGES: EscalationHistory = {
  exhausted: ["agnes-flash", "agnes-regular"],
  failures: ["reference-identity-mismatch", "reference-identity-mismatch"],
};
const FLASH_ONLY: EscalationHistory = {
  exhausted: ["agnes-flash"],
  failures: ["reference-identity-mismatch"],
};
/** Both Agnes stages exhausted on a NON-identity failure class. */
const COST_STAGES: EscalationHistory = {
  exhausted: ["agnes-flash", "agnes-regular"],
  failures: ["provider-timeout", "provider-timeout"],
};

const BASE_SHOT: SeedanceFallbackShot = {
  shotId: "S01E01_SC04_SH07",
  referenceImageUrls: [
    "https://media.example.test/characters/monica/face-front-master-v1.png",
    "https://media.example.test/characters/monica/wardrobe-business-blue-v1.png",
  ],
  prompt:
    "Monica Bennett, medium close-up, office, confident delivery, business-blue blazer, cinematic lighting",
  durationSeconds: 5,
};

describe("QC-009 shouldEscalateToSeedance (escalation gate)", () => {
  it("escalates when BOTH Agnes stages exhausted and identity failure persists", () => {
    expect(shouldEscalateToSeedance(IDENTITY_FAIL, BOTH_STAGES)).toBe(true);
  });

  it("does NOT escalate with only agnes-flash exhausted (must pass through agnes-regular first)", () => {
    expect(shouldEscalateToSeedance(IDENTITY_FAIL, FLASH_ONLY)).toBe(false);
  });

  it("does NOT escalate when agnes-regular not exhausted even if flash listed twice-safe", () => {
    const history: EscalationHistory = {
      exhausted: ["agnes-flash"],
      failures: ["reference-identity-mismatch"],
    };
    expect(shouldEscalateToSeedance(IDENTITY_FAIL, history)).toBe(false);
  });

  it("does NOT escalate when the triggering verdict is a non-identity failure (regression: verdict class must match)", () => {
    // History may still carry the identity class from the flash stage, but the
    // verdict that triggered this route call is a cost failure — not this
    // route's trigger (retry policy, QC-006).
    expect(shouldEscalateToSeedance(COST_FAIL, BOTH_STAGES)).toBe(false);
  });

  it("does NOT escalate when the triggering verdict is prop-mismatch (props are not identity)", () => {
    const propVerdict: QcOutcome = {
      status: "FAIL",
      failures: [{ failureClass: "prop-mismatch", detail: "coffee cup wrong" }],
    };
    expect(shouldEscalateToSeedance(propVerdict, BOTH_STAGES)).toBe(false);
  });

  it("does NOT escalate on non-identity failures (cost/timeout belong to retry policy)", () => {
    expect(shouldEscalateToSeedance(COST_FAIL, COST_STAGES)).toBe(false);
  });

  it("does NOT escalate on PASS or REVIEW", () => {
    expect(shouldEscalateToSeedance(PASS, BOTH_STAGES)).toBe(false);
    expect(shouldEscalateToSeedance({ status: "REVIEW", failures: [] }, BOTH_STAGES)).toBe(
      false,
    );
  });

  it("escalates on wardrobe/hair mismatch (identity-class failures)", () => {
    const history: EscalationHistory = {
      exhausted: ["agnes-flash", "agnes-regular"],
      failures: ["wardrobe-mismatch", "hair-mismatch"],
    };
    expect(shouldEscalateToSeedance(IDENTITY_FAIL, history)).toBe(true);
  });

  it("does NOT escalate when identity failure appeared only at flash stage, not persisting", () => {
    const history: EscalationHistory = {
      exhausted: ["agnes-flash", "agnes-regular"],
      failures: ["reference-identity-mismatch", "prop-mismatch"],
    };
    // prop-mismatch alone is not the identity class — route refuses.
    expect(shouldEscalateToSeedance(IDENTITY_FAIL, history)).toBe(false);
  });
});

describe("QC-009 routeSeedanceFallback (gate + composition)", () => {
  it("refuses escalation-not-earned when gate fails", () => {
    const result = routeSeedanceFallback(IDENTITY_FAIL, FLASH_ONLY, BASE_SHOT);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusal.reason).toBe("escalation-not-earned");
    }
  });

  it("composes the fallback for an earned escalation", () => {
    const result = routeSeedanceFallback(IDENTITY_FAIL, BOTH_STAGES, BASE_SHOT);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.model).toBe(SEEDANCE_2_MINI_MODEL);
      expect(result.value.mode).toBe("multimodal-reference");
      expect(result.value.request.input.reference_image_urls?.length).toBe(2);
    }
  });
});

describe("QC-009 mode constraints honored on fallback requests", () => {
  it("multimodal-reference mode carries reference images, never frame fields", () => {
    const result = buildSeedanceFallback(BASE_SHOT);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.mode).toBe("multimodal-reference");
      expect(result.value.request.input.first_frame_url).toBeUndefined();
      expect(result.value.request.input.last_frame_url).toBeUndefined();
      expect(result.value.request.input.reference_image_urls).toEqual(
        BASE_SHOT.referenceImageUrls,
      );
    }
  });

  it("first-frame-only shot maps to first-frame I2V mode", () => {
    const result = buildSeedanceFallback({
      ...BASE_SHOT,
      referenceImageUrls: undefined,
      firstFrameUrl: "https://media.example.test/keyframes/S01E01_SC04_SH07_start.png",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.mode).toBe("first-frame-i2v");
      expect(result.value.request.input.first_frame_url).toBeDefined();
      expect(result.value.request.input.reference_image_urls).toBeUndefined();
    }
  });

  it("first+last frame shot maps to first-last-frame I2V", () => {
    const result = buildSeedanceFallback({
      ...BASE_SHOT,
      referenceImageUrls: undefined,
      firstFrameUrl: "https://media.example.test/keyframes/start.png",
      lastFrameUrl: "https://media.example.test/keyframes/end.png",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.mode).toBe("first-last-frame-i2v");
    }
  });

  it("fails closed on mixed mode groups (frames + references)", () => {
    const result = buildSeedanceFallback({
      ...BASE_SHOT,
      firstFrameUrl: "https://media.example.test/keyframes/start.png",
      lastFrameUrl: "https://media.example.test/keyframes/end.png",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusal.reason).toBe("constraints-unimplementable");
    }
  });

  it("fails closed on last frame without first frame (not a documented mode)", () => {
    const result = buildSeedanceFallback({
      ...BASE_SHOT,
      referenceImageUrls: undefined,
      lastFrameUrl: "https://media.example.test/keyframes/end.png",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusal.reason).toBe("constraints-unimplementable");
    }
  });

  it("refuses zero-reference fallback (no identity anchoring cannot address the trigger)", () => {
    const result = buildSeedanceFallback({
      ...BASE_SHOT,
      referenceImageUrls: undefined,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusal.reason).toBe("constraints-unimplementable");
    }
  });

  it("adapter validation still enforced: over-max references refused as invalid-request", () => {
    const manyImages = Array.from(
      { length: 10 },
      (_, i) => `https://media.example.test/refs/ref-${i}.png`,
    );
    const result = buildSeedanceFallback({
      ...BASE_SHOT,
      referenceImageUrls: manyImages,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusal.reason).toBe("invalid-request");
      expect(result.refusal.detail).toContain("reference_image_urls");
    }
  });

  it("duration/resolution clamp to documented Seedance bounds", () => {
    const outOfRange = buildSeedanceFallback({
      ...BASE_SHOT,
      durationSeconds: 30,
    });
    expect(outOfRange.ok).toBe(false);
    expect(SEEDANCE_FALLBACK_DURATION).toEqual({ min: 4, max: 15, default: 5 });
  });

  it("referencesUsed carries every reference for provenance", () => {
    const result = buildSeedanceFallback(BASE_SHOT);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.referencesUsed).toEqual(BASE_SHOT.referenceImageUrls);
    }
  });

  it("referencesUsed excludes keyframe fields — frames are strategy, not references (regression)", () => {
    const result = buildSeedanceFallback({
      ...BASE_SHOT,
      referenceImageUrls: undefined,
      firstFrameUrl: "https://media.example.test/keyframes/start.png",
      lastFrameUrl: "https://media.example.test/keyframes/end.png",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.referencesUsed).toEqual([]);
    }
  });

  it("type level: prop-mismatch is not an accepted persisting failure class", () => {
    expectTypeOf<PersistingFailureClass>().not.toEqualTypeOf<
      PersistingFailureClass | "prop-mismatch"
    >();
  });
});