/// <reference types="node" />
/**
 * KIE-010 — wire-shape builders pinned to the live docs.kie.ai facts
 * recorded in docs/provider-capabilities/kie.md (verified 2026-08-28).
 */
import { envelope, jsonResponse } from "./helpers.js";
import type { KieRecordInfoData } from "../client/index.js";

/** recordInfo success envelope with a typed `data` payload. */
export function recordInfo(data: KieRecordInfoData): Response {
  return jsonResponse(200, envelope(data));
}