/**
 * Native graphics layer (VID-008) — public surface.
 *
 * Pure core (typechecked + unit-tested): types, brand tokens, layout/timing
 * math, composition, credits scroll, plan validation.
 *
 * Remotion view components live in ./views (thin, declarative-only wrappers
 * over the core) — they import `remotion` at mount time in the episodic
 * composition (VID-012 wiring); the package tsconfig keeps them out of the
 * strict package typecheck because `remotion` itself is a peer dep resolved
 * inside the upstream `remotion/` project, not this package.
 */

export * from "./types.js";
export * from "./tokens.js";
export * from "./layout.js";
export * from "./compose.js";
export * from "./credits.js";
export * from "./validate.js";