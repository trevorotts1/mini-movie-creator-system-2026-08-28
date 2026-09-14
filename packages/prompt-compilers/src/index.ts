/**
 * @mmcs/prompt-compilers — NOT IMPLEMENTED. Importing this module throws.
 *
 * SKR-043: this file shipped as a one-line scaffold marker
 * (`export const MMCS_PROMPT_COMPILERS = "@mmcs/prompt-compilers scaffold
 * marker"`) while the package was aliased as a real module in
 * tsconfig.base.json, packages/tsconfig.pkg.json, the root vitest.config.ts
 * and every package-local vitest config. An import of
 * `@mmcs/prompt-compilers` therefore resolved to a no-op that looked exactly
 * like a working module: a consumer compiled against it and got `undefined`
 * at runtime with nothing to notice.
 *
 * docs/ARCHITECTURE.md ("Packages") specifies the real contract — "Compile
 * story/script/shot data into provider prompts. Pure functions over `domain`
 * types." — and it cannot be met today: @mmcs/domain, the package those pure
 * functions take their types from, is itself still a scaffold marker that
 * throws on import. Emitting a placeholder compiler here would be the same lie
 * in a longer form, so an import must fail visibly instead.
 *
 * To implement it: implement @mmcs/domain first, then replace this throw with
 * the real compilers and delete ./index.test.ts, whose only job is to hold
 * this module to that.
 */
throw new Error(
  "@mmcs/prompt-compilers is a scaffold marker with no implementation — " +
    'docs/ARCHITECTURE.md gives it "pure functions over domain types", and ' +
    "@mmcs/domain has no implementation to be pure over yet (SPEC.md " +
    "SKR-043). Importing it must not silently succeed: implement the " +
    "compilers (after the domain model), or stop depending on this package.",
);

export {};
