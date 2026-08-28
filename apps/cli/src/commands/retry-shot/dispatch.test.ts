// VID-013 dispatcher-level test — `mmcs retry-shot <id>` wired over the
// CORE-011 stub via mergeSpecs/buildProgram (the integration seam this task
// hands to the batch merger).
import { describe, expect, it } from "vitest";
import { buildProgram, dispatch } from "../../dispatch/dispatcher.js";
import { buildRegistry, mergeSpecs } from "../../dispatch/registry.js";
import type { Handler } from "../../dispatch/stubs.js";
import {
  RETRY_SHOT_SPEC,
  makeRetryShotHandler,
  type EpisodicShotPlanLike,
  type RetryShotPorts,
} from "./commands.js";

function fixturePlan(): EpisodicShotPlanLike {
  return {
    episodeId: "S01E01",
    fps: 30,
    segments: [
      {
        shotId: "SH01",
        sceneId: "SC01",
        sequenceIndex: 1,
        durationInFrames: 90,
        inputs: { layerKind: "generated-video", assetRef: "ghl://a.mp4" },
      },
      {
        shotId: "SH02",
        sceneId: "SC01",
        sequenceIndex: 2,
        durationInFrames: 120,
        inputs: { layerKind: "generated-video", assetRef: "ghl://b.mp4" },
      },
    ],
  };
}

function captureOut(): { writes: string[]; restore: () => void } {
  const writes: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  return { writes, restore: () => (process.stdout.write = orig) };
}

describe("retry-shot dispatcher wiring", () => {
  it("RETRY_SHOT_SPEC merges over the base registry without losing any verb", () => {
    const merged = mergeSpecs(buildRegistry(), [RETRY_SHOT_SPEC]);
    const names = merged.map((c) => c.name);
    expect(names).toContain("retry-shot");
    // every base verb survives
    for (const spec of buildRegistry()) {
      expect(names).toContain(spec.name);
    }
    const retry = merged.find((c) => c.name === "retry-shot")!;
    expect(retry.args).toEqual(["<id>"]);
    expect(retry.description).toContain("only that shot regenerates");
  });

  it("buildProgram wires the real handler: unknown shot exits 1 via thrown error", async () => {
    const ports: RetryShotPorts = {
      loadPlan: () => undefined,
      queueShotRegeneration: () => "job-1",
    };
    const overrides: Record<string, Handler> = {
      "retry-shot": makeRetryShotHandler(ports) as Handler,
    };
    const program = buildProgram(mergeSpecs(buildRegistry(), [RETRY_SHOT_SPEC]), overrides);
    const cap = captureOut();
    const origErr = process.stderr.write.bind(process.stderr);
    process.stderr.write = () => true;
    try {
      let caught: unknown;
      try {
        await program.parseAsync(["retry-shot", "NOPE"], { from: "user" });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toContain("exit 1");
    } finally {
      cap.restore();
      process.stderr.write = origErr;
    }
  });

  it("dispatch stays stub-compatible when no override is supplied (default surface intact)", async () => {
    const cap = captureOut();
    try {
      const result = await dispatch(["retry-shot", "SH01"]);
      expect(result.exitCode).toBe(0);
    } finally {
      cap.restore();
    }
    expect(cap.writes.join("")).toContain("STUB: registered, not implemented yet");
  });
});
