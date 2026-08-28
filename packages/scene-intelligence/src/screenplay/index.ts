/**
 * Screenplay barrel — DIR-004.
 *
 * NOTE (merger): `packages/scene-intelligence/src/index.ts` is the package
 * barrel and is shared across all WF03 tasks (ownership.md). This module does
 * NOT edit it. Add `export * from "./screenplay/index.js";` to
 * `packages/scene-intelligence/src/index.ts` when folding DIR-004 into the
 * integration branch — same pattern CAP-006 used for its barrel.
 */

export * from "./types.js";
export * from "./writer-model.js";
export * from "./prompt.js";
export * from "./parse.js";
export * from "./generator.js";