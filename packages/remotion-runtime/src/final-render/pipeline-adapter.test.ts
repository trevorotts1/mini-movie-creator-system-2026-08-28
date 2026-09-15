import { describe, expect, it } from "vitest";
import {
  makePipelineRenderPort,
  toRemotionRenderRequest,
} from "./pipeline-adapter.js";
import type { RenderRequest } from "./pipeline.js";

/** A pipeline-shaped request (resolution object + durationSeconds). */
const PIPELINE_REQUEST: RenderRequest = {
  compositionId: "S01E01",
  entryPoint: "/repo/remotion/src/index.ts",
  scale: 1,
  resolution: { width: 1920, height: 1080 },
  fps: 30,
  durationSeconds: 12,
  output: "/tmp/S01E01_final_v01.mp4",
  codec: "h264",
  publicDir: "/repo/media",
};

describe("toRemotionRenderRequest", () => {
  it("flattens resolution and converts seconds into whole frames", () => {
    const r = toRemotionRenderRequest(PIPELINE_REQUEST);
    expect(r.width).toBe(1920);
    expect(r.height).toBe(1080);
    expect(r.durationInFrames).toBe(360); // 12s @ 30fps
    expect(r.compositionId).toBe("S01E01");
    expect(r.scale).toBe(1);
    expect(r.entryPoint).toBe("/repo/remotion/src/index.ts");
    expect(r.publicDir).toBe("/repo/media");
    expect(r.output).toBe("/tmp/S01E01_final_v01.mp4");
    expect(r.codec).toBe("h264");
  });

  it("rounds a fractional duration up to whole frames, never below one", () => {
    // 10.02s @ 30fps = 300.6 frames. Truncating would silently shorten the
    // episode; Remotion rejects a fractional durationInFrames outright.
    const rounded = toRemotionRenderRequest({ ...PIPELINE_REQUEST, durationSeconds: 10.02 });
    expect(rounded.durationInFrames).toBe(301);
    expect(Number.isInteger(rounded.durationInFrames)).toBe(true);
    // A sub-frame duration must not collapse to zero frames.
    const tiny = toRemotionRenderRequest({ ...PIPELINE_REQUEST, durationSeconds: 0.001 });
    expect(tiny.durationInFrames).toBe(1);
  });

  it("omits entryPoint and publicDir rather than passing explicit undefined", () => {
    // The adapter distinguishes "absent" from "present but undefined" when it
    // resolves the entry point across request → options → env.
    const withoutOptional: RenderRequest = { ...PIPELINE_REQUEST };
    delete (withoutOptional as { entryPoint?: string }).entryPoint;
    delete (withoutOptional as { publicDir?: string }).publicDir;
    const r = toRemotionRenderRequest(withoutOptional);
    expect("entryPoint" in r).toBe(false);
    expect("publicDir" in r).toBe(false);
  });
});

describe("makePipelineRenderPort", () => {
  it("drives the adapter with the converted request", async () => {
    const rendered: { composition: { durationInFrames: number } }[] = [];
    const port = makePipelineRenderPort({
      loadModules: async () => ({
        bundle: async () => "/tmp/fake-serve-url",
        selectComposition: async () => ({
          durationInFrames: 999,
          width: 1920,
          height: 1080,
          fps: 30,
          props: {},
        }),
        renderMedia: async (input: unknown) => {
          rendered.push(input as { composition: { durationInFrames: number } });
          return { contentType: "video/mp4", contentLength: 1 };
        },
      }),
    });

    const result = await port(PIPELINE_REQUEST);
    expect(result.output).toBe("/tmp/S01E01_final_v01.mp4");
    expect(typeof result.renderSeconds).toBe("number");
    expect(rendered).toHaveLength(1);
    // The pipeline's duration wins over the composition's own 999.
    expect(rendered[0]?.composition.durationInFrames).toBe(360);
  });

  it("fails with a named error instead of rendering when no entry point is known", async () => {
    const withoutEntry: RenderRequest = { ...PIPELINE_REQUEST };
    delete (withoutEntry as { entryPoint?: string }).entryPoint;
    const port = makePipelineRenderPort({});
    await expect(port(withoutEntry)).rejects.toThrow(/entry point/i);
  });
});
