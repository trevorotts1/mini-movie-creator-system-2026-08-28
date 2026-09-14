/**
 * @mmcs/domain — NOT IMPLEMENTED. Importing this module throws.
 *
 * SKR-043: this file shipped as a one-line scaffold marker
 * (`export const MMCS_DOMAIN = "@mmcs/domain scaffold marker"`) while the
 * package was aliased as a real module in tsconfig.base.json,
 * packages/tsconfig.pkg.json, the root vitest.config.ts and every
 * package-local vitest config. An import of `@mmcs/domain` therefore resolved
 * to a no-op that looked exactly like a working module: a consumer compiled
 * against it and got `undefined` at runtime with nothing to notice.
 *
 * docs/ARCHITECTURE.md ("Packages") specifies the real contract — "Pure domain
 * model: projects, series, episodes, scenes, shots, characters, approvals, QC
 * results, costs. No I/O, no dependencies." — and that model does not exist
 * yet. Inventing a placeholder type surface here would be the same lie in a
 * longer form, so until it is written an import must fail visibly instead.
 *
 * To implement it: replace this throw with the real model and delete
 * ./index.test.ts, whose only job is to hold this module to that.
 */
throw new Error(
  "@mmcs/domain is a scaffold marker with no implementation — the pure " +
    "domain model described in docs/ARCHITECTURE.md has not been written " +
    "(SPEC.md SKR-043). Importing it must not silently succeed: implement the " +
    "model, or stop depending on this package.",
);

export {};
