/**
 * Runtime-observed capability data for the Agnes AI provider (runbook §24
 * WF04/CAP-010: "older public docs show agnes-video-v2.0; record
 * runtime-discovered 2.5 IDs with source/date").
 *
 * Sources: live API probes on 2026-08-06 (GET /v1/models with a valid key)
 * returned the runtime model list below; the 512K/64K limits were probed
 * directly against `agnes-2.5-flash` (420k-token prompt accepted, 840k
 * rejected with "longer than context length (524288)"; 300k max_tokens
 * rejected with "exceeds the limit of 65536"). Video `agnes-video-v2.0`
 * probes: num_frames 8n+1, ≤441. Endpoint base https://apihub.agnes-ai.com/v1.
 *
 * These are RUNTIME observations: PROVISIONAL confidence with source+date —
 * they refine (never replace) human-verified profile values, per CAP-010.
 */

import type { RuntimeObservation } from "./observed-overrides.js";

/** The runtime-discovered Agnes model list (2026-08-06, live /v1/models). */
export const AGNES_RUNTIME_MODEL_IDS = [
  "agnes-2.0-flash",
  "agnes-2.5-flash",
  "agnes-2.5-pro",
  "agnes-2.5-pro-alpha",
  "agnes-image-2.0-flash",
  "agnes-image-2.1-flash",
  "agnes-video-v2.0",
] as const;

export const AGNES_RUNTIME_DISCOVERY = {
  provider: "agnes",
  observedAt: "2026-08-06T00:00:00.000Z",
  baseUrl: "https://apihub.agnes-ai.com/v1",
  sourceUrl: "https://apihub.agnes-ai.com/v1/models",
  /** Where these runtime facts were first proven and recorded. */
  verificationNote:
    "Live API probes 2026-08-06: GET /v1/models list; context/output limits probed by accepted/rejected request sizes against agnes-2.5-flash.",
} as const;

/** Runtime observations for Agnes 2.5 Flash text/reasoning limits. */
export const AGNES_25_FLASH_OBSERVATIONS: RuntimeObservation[] = [
  {
    facet: "modelList",
    kind: "modelList",
    method: "runtime",
    sourceUrl: AGNES_RUNTIME_DISCOVERY.sourceUrl,
    observedAt: AGNES_RUNTIME_DISCOVERY.observedAt,
    observedValue: [...AGNES_RUNTIME_MODEL_IDS],
    evidence: "GET /v1/models with valid key returned 7 model IDs",
    transientClass: null,
  },
  {
    facet: "contextWindowTokens",
    kind: "limitProbe",
    method: "runtime",
    sourceUrl: AGNES_RUNTIME_DISCOVERY.sourceUrl,
    observedAt: AGNES_RUNTIME_DISCOVERY.observedAt,
    observedValue: 524288,
    evidence:
      "420k-token prompt accepted; 840k rejected: 'longer than context length (524288)'",
    transientClass: null,
  },
  {
    facet: "maxOutputTokens",
    kind: "limitProbe",
    method: "runtime",
    sourceUrl: AGNES_RUNTIME_DISCOVERY.sourceUrl,
    observedAt: AGNES_RUNTIME_DISCOVERY.observedAt,
    observedValue: 65536,
    evidence: "300k max_tokens rejected: 'exceeds the limit of 65536'",
    transientClass: null,
  },
  {
    facet: "toolCallingSupported",
    kind: "capabilityProbe",
    method: "runtime",
    sourceUrl: AGNES_RUNTIME_DISCOVERY.sourceUrl,
    observedAt: AGNES_RUNTIME_DISCOVERY.observedAt,
    observedValue: true,
    evidence: "tool-call smoke test returned a parsed tool call",
    transientClass: null,
  },
];

/** Runtime observations for Agnes Video v2.0. */
export const AGNES_VIDEO_V2_OBSERVATIONS: RuntimeObservation[] = [
  {
    facet: "modelList",
    kind: "modelList",
    method: "runtime",
    sourceUrl: AGNES_RUNTIME_DISCOVERY.sourceUrl,
    observedAt: AGNES_RUNTIME_DISCOVERY.observedAt,
    observedValue: "agnes-video-v2.0",
    evidence:
      "POST /v1/videos accepted model agnes-video-v2.0 (async; poll GET /agnesapi?video_id=)",
    transientClass: null,
  },
  {
    facet: "numFramesConstraint",
    kind: "limitProbe",
    method: "runtime",
    sourceUrl: AGNES_RUNTIME_DISCOVERY.sourceUrl,
    observedAt: AGNES_RUNTIME_DISCOVERY.observedAt,
    observedValue: 441,
    evidence: "num_frames must be 8n+1 and <= 441 per provider validation",
    transientClass: null,
  },
];

/**
 * The 2.5 runtime IDs specifically: the runbook calls these out because older
 * public docs only show agnes-video-v2.0. Recorded with source + date so
 * downstream profiles can cite provenance.
 */
export const AGNES_RUNTIME_DISCOVERED_25_IDS = [
  "agnes-2.5-flash",
  "agnes-2.5-pro",
  "agnes-2.5-pro-alpha",
] as const;