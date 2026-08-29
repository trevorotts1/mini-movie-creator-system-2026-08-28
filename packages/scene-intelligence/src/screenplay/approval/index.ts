/**
 * Screenplay approval barrel — DIR-008.
 *
 * NOTE (merger): `packages/scene-intelligence/src/index.ts` is the package
 * barrel and is shared across all WF03 tasks (ownership.md). This module does
 * NOT edit it. Add `export * from "./screenplay/approval/index.js";` to
 * `packages/scene-intelligence/src/index.ts` when folding DIR-008 into the
 * integration branch — same pattern the DIR-004 screenplay barrel used.
 */

export * from "./types.js";
export * from "./presenter.js";
export * from "./guard.js";
