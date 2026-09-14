import { describe, expect, it } from "vitest";

/**
 * SKR-043 guard: @mmcs/domain is a scaffold package, and the one thing it must
 * never do is import cleanly. Before this test the package exported a constant
 * whose value was the string "scaffold marker", so every import succeeded and
 * resolved to a no-op indistinguishable from a real module.
 *
 * If this test ever fails because the module no longer throws, the domain
 * model has been implemented — delete this file (and the throw in ./index.ts)
 * rather than weakening the assertion.
 */
describe("@mmcs/domain is not silently importable (SKR-043)", () => {
  it("rejects on import instead of resolving to a no-op", async () => {
    await expect(import("./index.js")).rejects.toThrow(
      /scaffold marker with no implementation/,
    );
  });
});
