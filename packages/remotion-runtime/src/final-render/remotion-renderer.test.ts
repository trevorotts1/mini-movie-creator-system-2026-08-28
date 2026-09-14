/// <reference types="node" />
// SKR-004 acceptance tests — the genuine Remotion render adapter.
//
// WHY these tests inject fake Remotion modules: `@remotion/renderer` drives a
// headless Chrome that it downloads on first use, so a real bundle/render
// cannot run in a unit test (it is recorded `not_verified` pending an install).
// Everything the adapter OWNS is still proven here: that it bundles from a
// real entry point, caches the bundle per entry point, selects the requested
// composition, forces the caller's frame duration, renders h264 to the
// requested path, and fails with a named error instead of silently rendering a
// test pattern when no entry point is configured.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  REMOTION_ENTRY_POINT_ERROR,
  loadRemotionRenderer,
  makeRemotionRenderAdapter,
  remotionRendererAvailable,
  resolveRemotionEntryPoint,
  type RemotionRenderMediaInput,
  type RemotionRendererModules,
} from "./remotion-renderer.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/** What one fake render run observed — asserted by the tests below. */
interface FakeCalls {
  bundle: { entryPoint: string; publicDir?: string }[];
  select: { serveUrl: string; id: string }[];
  render: RemotionRenderMediaInput[];
}

function fakeRenderer(
  over: Partial<{
    serveUrl: string;
    composition: Record<string, unknown>;
    renderMedia: () => Promise<unknown>;
    bundle: () => Promise<string>;
  }> = {},
): { modules: RemotionRendererModules; calls: FakeCalls } {
  const calls: FakeCalls = { bundle: [], select: [], render: [] };
  const modules: RemotionRendererModules = {
    bundle: async (input) => {
      calls.bundle.push({ entryPoint: input.entryPoint, publicDir: input.publicDir });
      if (over.bundle) return over.bundle();
      return over.serveUrl ?? "/tmp/mmcs-fake-bundle";
    },
    selectComposition: async ({ serveUrl, id }) => {
      calls.select.push({ serveUrl, id });
      return {
        durationInFrames: 999,
        width: 1920,
        height: 1080,
        fps: 30,
        props: {},
        ...over.composition,
      };
    },
    renderMedia: async (input) => {
      calls.render.push(input);
      if (over.renderMedia) return over.renderMedia();
      return { contentType: "video/mp4", contentLength: 1 };
    },
  };
  return { modules, calls };
}

const BASE_REQUEST = {
  compositionId: "S01E01",
  entryPoint: "/repo/remotion/src/index.ts",
  output: "/tmp/S01E01_final_v01.mp4",
  fps: 30,
  width: 1920,
  height: 1080,
  durationInFrames: 360,
  codec: "h264" as const,
};

describe("genuine render path — bundle → selectComposition → renderMedia (SKR-004)", () => {
  it("bundles the entry point, selects the composition, and renders h264 to the output path", async () => {
    const { modules, calls } = fakeRenderer({ serveUrl: "/tmp/bundle-1" });
    const adapter = makeRemotionRenderAdapter({
      loadModules: async () => modules,
      publicDir: "/repo/media",
    });

    const result = await adapter(BASE_REQUEST);

    expect(calls.bundle).toEqual([
      { entryPoint: "/repo/remotion/src/index.ts", publicDir: "/repo/media" },
    ]);
    expect(calls.select).toEqual([{ serveUrl: "/tmp/bundle-1", id: "S01E01" }]);
    expect(calls.render).toHaveLength(1);
    const rendered = calls.render[0]!;
    expect(rendered.serveUrl).toBe("/tmp/bundle-1");
    expect(rendered.outputLocation).toBe("/tmp/S01E01_final_v01.mp4");
    expect(rendered.codec).toBe("h264");
    expect(rendered.overwrite).toBe(true);
    // Native scale by default: the spec forbids claiming resolution that was
    // not rendered.
    expect(rendered.scale).toBe(1);
    expect(result).toEqual({ output: "/tmp/S01E01_final_v01.mp4", renderSeconds: expect.any(Number) });
  });

  it("forces the caller's durationInFrames over the composition's own duration", async () => {
    const { modules, calls } = fakeRenderer({ composition: { durationInFrames: 999 } });
    const adapter = makeRemotionRenderAdapter({ loadModules: async () => modules });

    await adapter({ ...BASE_REQUEST, durationInFrames: 72 });

    expect(calls.render[0]!.composition.durationInFrames).toBe(72);
  });

  it("bundles once and reuses the serve URL for later renders (render batches pay webpack once)", async () => {
    const { modules, calls } = fakeRenderer({ serveUrl: "/tmp/bundle-cached" });
    let loads = 0;
    const adapter = makeRemotionRenderAdapter({
      loadModules: async () => {
        loads += 1;
        return modules;
      },
    });

    await adapter(BASE_REQUEST);
    await adapter({ ...BASE_REQUEST, output: "/tmp/second.mp4" });

    expect(calls.bundle).toHaveLength(1);
    // loadModules is consulted per render (the real one is a dynamic import,
    // which Node caches per specifier — cheap); only the BUNDLE is memoized.
    expect(loads).toBe(2);
    expect(calls.select.map((s) => s.serveUrl)).toEqual([
      "/tmp/bundle-cached",
      "/tmp/bundle-cached",
    ]);
    expect(calls.render.map((r) => r.outputLocation)).toEqual([
      "/tmp/S01E01_final_v01.mp4",
      "/tmp/second.mp4",
    ]);
  });

  it("re-bundles when the entry point changes, and reports each bundle", async () => {
    const { modules, calls } = fakeRenderer();
    const bundled: string[] = [];
    const adapter = makeRemotionRenderAdapter({
      loadModules: async () => modules,
      onBundle: (_serveUrl, entryPoint) => bundled.push(entryPoint),
    });

    await adapter(BASE_REQUEST);
    await adapter({ ...BASE_REQUEST, entryPoint: "/repo/rm-other/src/index.ts" });

    expect(calls.bundle.map((b) => b.entryPoint)).toEqual([
      "/repo/remotion/src/index.ts",
      "/repo/rm-other/src/index.ts",
    ]);
    expect(bundled).toEqual([
      "/repo/remotion/src/index.ts",
      "/repo/rm-other/src/index.ts",
    ]);
  });

  it("does not memoize a failed bundle — the next render retries instead of replaying the failure", async () => {
    let attempts = 0;
    const { modules } = fakeRenderer({
      bundle: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("webpack exploded");
        return "/tmp/bundle-after-retry";
      },
    });
    const adapter = makeRemotionRenderAdapter({ loadModules: async () => modules });

    await expect(adapter(BASE_REQUEST)).rejects.toThrow(/webpack exploded/);
    await expect(adapter(BASE_REQUEST)).resolves.toMatchObject({
      output: BASE_REQUEST.output,
    });
    expect(attempts).toBe(2);
  });

  it("rejects a render whose composition is not registered in the bundle", async () => {
    const { modules } = fakeRenderer();
    modules.selectComposition = async () => undefined as never;
    const adapter = makeRemotionRenderAdapter({ loadModules: async () => modules });

    await expect(adapter(BASE_REQUEST)).rejects.toThrow(/returned no composition/);
  });

  it("rejects an empty serve URL from bundle()", async () => {
    const { modules } = fakeRenderer({ serveUrl: "" });
    const adapter = makeRemotionRenderAdapter({ loadModules: async () => modules });

    await expect(adapter(BASE_REQUEST)).rejects.toThrow(/no serve URL/);
  });

  it("surfaces a renderer failure to the caller (never a silent success)", async () => {
    const { modules } = fakeRenderer({
      renderMedia: async () => {
        throw new Error("browser crashed at frame 12");
      },
    });
    const adapter = makeRemotionRenderAdapter({ loadModules: async () => modules });

    await expect(adapter(BASE_REQUEST)).rejects.toThrow(/browser crashed at frame 12/);
  });
});

describe("entry point resolution — a missing bundle is a named failure, never a test pattern", () => {
  it("prefers the request, then the adapter option, then MMCS_REMOTION_ENTRY", () => {
    expect(
      resolveRemotionEntryPoint(
        { compositionId: "S01E01", entryPoint: "/request.tsx" },
        { entryPoint: "/option.tsx" },
      ),
    ).toBe("/request.tsx");
    expect(
      resolveRemotionEntryPoint({ compositionId: "S01E01" }, { entryPoint: "/option.tsx" }),
    ).toBe("/option.tsx");
    process.env.MMCS_REMOTION_ENTRY = "/env.tsx";
    try {
      expect(resolveRemotionEntryPoint({ compositionId: "S01E01" })).toBe("/env.tsx");
    } finally {
      delete process.env.MMCS_REMOTION_ENTRY;
    }
  });

  it("throws a named error naming the composition, the option and the env var", () => {
    delete process.env.MMCS_REMOTION_ENTRY;
    expect(() => resolveRemotionEntryPoint({ compositionId: "S01E07" })).toThrowError(
      new RegExp(`${REMOTION_ENTRY_POINT_ERROR}.*S01E07.*MMCS_REMOTION_ENTRY`, "s"),
    );
  });

  it("fails the render rather than falling back when no entry point exists anywhere", async () => {
    delete process.env.MMCS_REMOTION_ENTRY;
    const { modules, calls } = fakeRenderer();
    const adapter = makeRemotionRenderAdapter({ loadModules: async () => modules });

    await expect(
      adapter({ ...BASE_REQUEST, entryPoint: undefined }),
    ).rejects.toThrow(REMOTION_ENTRY_POINT_ERROR);
    expect(calls.bundle).toHaveLength(0);
    expect(calls.render).toHaveLength(0);
  });

  it("blank/whitespace entry points do not count as configured", async () => {
    const { modules } = fakeRenderer();
    const adapter = makeRemotionRenderAdapter({ loadModules: async () => modules });
    await expect(
      adapter({ ...BASE_REQUEST, entryPoint: "   " }),
    ).rejects.toThrow(REMOTION_ENTRY_POINT_ERROR);
  });
});

describe("loadRemotionRenderer — the real dependency seam", () => {
  it("names the install step when the Remotion packages are not installed here", async () => {
    // This checkout has @remotion/* declared but genuinely NOT installed
    // (SKR-004 shipped the declaration without an install). The adapter must
    // say so precisely rather than fail as "undefined is not a function" —
    // and it must NOT quietly substitute the ffmpeg fixture.
    const available = await remotionRendererAvailable();
    if (available) return; // a host that did install them: nothing to assert
    await expect(loadRemotionRenderer()).rejects.toThrow(
      /Remotion renderer unavailable.*pnpm install/s,
    );
  });
});

describe("package manifest — the render dependencies are declared (SKR-004)", () => {
  it("declares @remotion/bundler and @remotion/renderer on the remotion major.minor line", () => {
    const manifest = JSON.parse(
      readFileSync(join(HERE, "..", "..", "package.json"), "utf8"),
    ) as {
      dependencies: Record<string, string>;
    };
    const line = (range: string) => range.replace(/^[^\d]*/, "").split(".").slice(0, 2).join(".");
    const remotionLine = line(manifest.dependencies["remotion"]!);
    expect(remotionLine).toMatch(/^4\.\d+$/);
    for (const dep of ["@remotion/bundler", "@remotion/renderer"]) {
      const declared = manifest.dependencies[dep];
      expect(declared, `${dep} must be declared`).toBeDefined();
      // Remotion requires ONE version across the family: the declared ranges
      // must agree on the major.minor line, or the renderer refuses to run.
      expect(line(declared!), `${dep} must match remotion ${remotionLine}`).toBe(remotionLine);
    }
  });
});
