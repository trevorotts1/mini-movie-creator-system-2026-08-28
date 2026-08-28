/**
 * KIE-009 — Kie failure normalization. Public surface.
 *
 * Every Kie failure shape (HTTP status, transport throw, task-info failure
 * payload, unknown thrown value) normalizes to one
 * {@link NormalizedKieFailure} taxonomy: `retryable` / `fatal` / `quota`.
 * Nothing exported here can emit a secret into a log line.
 */
export type {
  KieFailureClass,
  KieFailureSource,
  NormalizedKieFailure,
} from "./taxonomy.js";
export { KieNormalizedError } from "./taxonomy.js";

export { REDACTED, looksSecretLike, redactSecrets, redactDeep, failureToLogLine } from "./redact.js";

export { classifyKieHttpFailure } from "./http.js";
export type { KieHttpBody } from "./http.js";

export { classifyKieTaskFailure, isQuotaShapedTaskFailure } from "./task.js";
export type { KieTaskFailurePayload } from "./task.js";

export {
  normalizeKieFailure,
  normalizeKieFailureToError,
} from "./normalize.js";
export type {
  KieApiErrorLike,
  KieNormalizedErrorLike,
  UnknownFailure,
} from "./normalize.js";