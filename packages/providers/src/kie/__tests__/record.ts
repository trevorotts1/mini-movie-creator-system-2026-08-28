/// <reference types="node" />
/// <reference types="node" />
import type { KiePipelineState, KieTaskRecord } from "../task/index.js";

/** Build a KieTaskRecord with only the fields a test names. */
export function recordOf(overrides: {
  ref: string;
  state: KiePipelineState;
  providerTaskId?: string;
  model?: string;
  submitRequest?: unknown;
  resultUrls?: string[];
  failure?: { message: string; code?: number; raw?: unknown };
  pollCount?: number;
}): KieTaskRecord {
  const now = "2026-08-28T00:00:00.000Z";
  return {
    ref: overrides.ref,
    state: overrides.state,
    ...(overrides.providerTaskId !== undefined ? { providerTaskId: overrides.providerTaskId } : {}),
    ...(overrides.model !== undefined ? { model: overrides.model } : {}),
    ...(overrides.submitRequest !== undefined
      ? { submitRequest: overrides.submitRequest as KieTaskRecord["submitRequest"] }
      : {}),
    ...(overrides.resultUrls !== undefined ? { resultUrls: overrides.resultUrls } : {}),
    ...(overrides.failure !== undefined ? { failure: overrides.failure } : {}),
    ...(overrides.pollCount !== undefined ? { pollCount: overrides.pollCount } : {}),
    createdAt: now,
    updatedAt: now,
  };
}

/** Exported as a value so test files can import it directly. */
export default recordOf;