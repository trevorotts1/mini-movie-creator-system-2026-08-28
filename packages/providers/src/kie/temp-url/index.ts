/**
 * KIE-008 — temporary URL persistence. Public surface.
 *
 * Captures Kie result URLs (temporary by contract) into durable storage the
 * moment a task reaches GENERATED_TEMPORARY, persisting provider URL +
 * expiration immediately, then triggering the archival handoff to the GHL
 * emergency archival layer (GHL-012 integration point).
 *
 * Guarantees (runbook §21/§14.4):
 * - URLs are persisted BEFORE the handoff fires → restart-at-
 *   GENERATED_TEMPORARY always has the known URL to archive.
 * - Capture is idempotent; restarts re-arm pending handoffs but never
 *   duplicate records or double-trigger.
 * - Nothing here regenerates an asset, ever. A failed handoff is recorded
 *   (FAILED + redacted error) for the archival layer's retry.
 * - Expiration is persisted only when the provider states one; Kie's schema
 *   states no TTL (verified 2026-08-28) → stays UNKNOWN, never invented.
 */
export type {
  TempUrlArchiveRequest,
  TempUrlArchivalHandoff,
  TempUrlCapturerOptions,
  TempUrlHandoffResult,
  TempUrlHandoffStatus,
  TempUrlRecord,
  TempUrlStore,
} from "./types.js";
export { TempUrlCaptureError } from "./capture.js";
export { captureIntoKieRecord, TempUrlCapturer } from "./capture.js";