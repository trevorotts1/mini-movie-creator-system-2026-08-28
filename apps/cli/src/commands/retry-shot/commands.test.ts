// VID-013 acceptance tests — `mmcs retry-shot <id>` command wiring (§20, §24).
//
// The command layer must: parse strict options, load the plan through an
// injected port, scope the retry to EXACTLY the named shot (spec §20 —
// targeted repair only), apply new asset/trim inputs, prove the diff names
// only that shot, and refuse to queue spend without an injected runner.
// Story/script text is inert data here — compared/echoed, never executed (§29).
import { describe, expect, it } from "vitest";
import {
  RETRY_SHOT_SPEC,
  USAGE_RETRY_SHOT,
  makeRetryShotHandler,
  parseRetryShotOptions,
  runRetryShot,
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
      {
        shotId: "SH03",
        sceneId: "SC02",
        sequenceIndex: 3,
        durationInFrames: 75,
        inputs: { layerKind: "still-motion", assetRef: "ghl://c.png" },
      },
    ],
  };
}

function makePorts(
  opts: { plan?: EpisodicShotPlanLike | null; jobs?: string[] } = {},
): { ports: RetryShotPorts; queued: { shotId: string; attempt: number; replacement: unknown }[] } {
  const plan = opts.plan !== undefined ? opts.plan : fixturePlan();
  const jobs = opts.jobs ?? ["job-1"];
  const queued: { shotId: string; attempt: number; replacement: unknown }[] = [];
  let n = 0;
  return {
    ports: {
      loadPlan: (shotId) =>
        plan && plan.segments.some((s) => s.shotId === shotId) ? plan : undefined,
      queueShotRegeneration: (shotId, attempt, replacement) => {
        queued.push({ shotId, attempt, replacement });
        return jobs[n++] ?? undefined;
      },
    },
    queued,
  };
}

describe("parseRetryShotOptions", () => {
  it("parses asset/trim/duration/attempt/reason/json", () => {
    const o = parseRetryShotOptions([
      "--asset",
      "ghl://new.mp4",
      "--trim-in",
      "10",
      "--trim-out",
      "200",
      "--duration",
      "60",
      "--attempt",
      "2",
      "--reason",
      "QC FAIL: identity drift",
      "--json",
    ]);
    expect(o.asset).toBe("ghl://new.mp4");
    expect(o.trimInFrames).toBe(10);
    expect(o.trimOutFrames).toBe(200);
    expect(o.durationInFrames).toBe(60);
    expect(o.attempt).toBe(2);
    expect(o.reason).toBe("QC FAIL: identity drift");
    expect(o.json).toBe(true);
    expect(o.parseError).toBeUndefined();
  });

  it("rejects unknown flags, missing values, and non-integer frames", () => {
    expect(parseRetryShotOptions(["--bogus", "x"]).parseError).toMatch(/unknown option/);
    expect(parseRetryShotOptions(["--asset"]).parseError).toMatch(/requires a value/);
    expect(parseRetryShotOptions(["--trim-in", "3.5"]).parseError).toMatch(/non-negative integer/);
    expect(parseRetryShotOptions(["--trim-in", "-4"]).parseError).toMatch(/non-negative integer/);
    expect(parseRetryShotOptions(["loose-word"]).parseError).toMatch(/unexpected argument/);
  });
});

describe("runRetryShot", () => {
  it("happy path: scopes regeneration to exactly the named shot, queues one job, exits 0", () => {
    const { ports, queued } = makePorts();
    const result = runRetryShot(
      "SH02",
      ["--asset", "ghl://media/S01E01_SH02_v02.mp4", "--trim-in", "0", "--trim-out", "90"],
      ports,
    );
    expect(result.exitCode).toBe(0);
    expect(result.lines.join("\n")).toContain("regenerates [SH02]");
    expect(result.lines.join("\n")).toContain("preserves 2 shot(s): SH01, SH03");
    expect(queued).toEqual([
      {
        shotId: "SH02",
        attempt: 1,
        replacement: {
          assetRef: "ghl://media/S01E01_SH02_v02.mp4",
          trimInFrames: 0,
          trimOutFrames: 90,
          attempt: 1,
        },
      },
    ]);
  });

  it("explicit duration maps to durationPolicy explicit", () => {
    const { ports, queued } = makePorts();
    const result = runRetryShot("SH03", ["--duration", "60"], ports);
    expect(result.exitCode).toBe(0);
    const replacement = queued[0]!.replacement as Record<string, unknown>;
    expect(replacement.durationPolicy).toBe("explicit");
    expect(replacement.durationInFrames).toBe(60);
  });

  it("--json emits a machine-readable line with the full scope", () => {
    const { ports } = makePorts();
    const result = runRetryShot("SH01", ["--asset", "ghl://n.mp4", "--json"], ports);
    expect(result.exitCode).toBe(0);
    const json = result.json as Record<string, unknown>;
    expect(json.shotId).toBe("SH01");
    expect(json.regeneratesShotIds).toEqual(["SH01"]);
    expect(json.preservedShotIds).toEqual(["SH02", "SH03"]);
    expect(typeof json.jobId).toBe("string");
  });

  it("unknown shot id exits 1 without queueing spend", () => {
    const { ports, queued } = makePorts();
    const result = runRetryShot("SH99", ["--asset", "ghl://x.mp4"], ports);
    expect(result.exitCode).toBe(1);
    expect(result.lines[0]).toContain('unknown shot id "SH99"');
    expect(queued).toEqual([]);
  });

  it("missing plan loader (no DB row) exits 1 without queueing", () => {
    const { ports, queued } = makePorts({ plan: null });
    const result = runRetryShot("SH01", [], ports);
    expect(result.exitCode).toBe(1);
    expect(queued).toEqual([]);
  });

  it("no wired regeneration runner exits 1 — never spends without injection", () => {
    const { ports } = makePorts({ jobs: [] });
    const result = runRetryShot("SH01", ["--asset", "ghl://n.mp4"], ports);
    expect(result.exitCode).toBe(1);
    expect(result.lines.join("\n")).toContain("no shot-regeneration runner wired");
  });

  it("usage errors exit 2 with usage text", () => {
    const { ports } = makePorts();
    expect(runRetryShot(undefined, [], ports).exitCode).toBe(2);
    expect(runRetryShot(undefined, [], ports).lines[0]).toBe(USAGE_RETRY_SHOT);
    expect(runRetryShot("SH01", ["--nope", "x"], ports).exitCode).toBe(2);
  });

  it("same-input retry is legal — regeneration without new inputs is the seed-retry case", () => {
    const { ports, queued } = makePorts();
    const result = runRetryShot("SH01", ["--attempt", "3", "--reason", "seed variation"], ports);
    expect(result.exitCode).toBe(0);
    expect(queued[0]!.attempt).toBe(3);
    const replacement = queued[0]!.replacement as Record<string, unknown>;
    expect(replacement.reason).toBe("seed variation");
    expect(replacement.assetRef).toBeUndefined();
  });
});

describe("makeRetryShotHandler", () => {
  function capture(): { stdout: string[]; stderr: string[] } {
    const out = { stdout: [] as string[], stderr: [] as string[] };
    return out;
  }

  it("writes result lines to stdout and exits without throw on success", () => {
    const { ports } = makePorts();
    const cap = capture();
    const origOut = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      cap.stdout.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      const handler = makeRetryShotHandler(ports);
      handler({ id: "SH02" }, { asset: "ghl://n.mp4" });
    } finally {
      process.stdout.write = origOut;
    }
    expect(cap.stdout.join("")).toContain("regenerates [SH02]");
  });

  it("throws (dispatcher maps to exit 1) on unknown shot", () => {
    const { ports } = makePorts();
    const handler = makeRetryShotHandler(ports);
    expect(() => handler({ id: "NOPE" }, {})).toThrow(/exit 1/);
  });
});

describe("RETRY_SHOT_SPEC", () => {
  it("matches the dispatcher contract shape exactly", () => {
    expect(RETRY_SHOT_SPEC.name).toBe("retry-shot");
    expect(RETRY_SHOT_SPEC.args).toEqual(["<id>"]);
    expect(RETRY_SHOT_SPEC.group).toBe("generation");
    expect(RETRY_SHOT_SPEC.description.length).toBeGreaterThan(0);
  });
});