/**
 * Local confidence tiers mirroring the CAP-001 capability schema tiers. The
 * schema module (packages/capability-registry/src/schema) is CAP-001's output
 * and may not be merged yet; observed-overrides only needs the tier names, so
 * they are declared here to keep this module dependency-light. Values match
 * the schema exactly; if they ever drift, this file is the place to reconcile.
 */

export const CONFIDENCE_LEVELS = ["VERIFIED", "PROVISIONAL", "UNKNOWN"] as const;

export type Confidence = (typeof CONFIDENCE_LEVELS)[number];