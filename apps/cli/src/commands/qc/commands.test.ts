// QC-011 CLI tests — `mmcs qc` surfaces the human REVIEW state (spec §20, §24).
//
// The command layer must: list open REVIEW items by default, filter by
// episode / include resolved, and — the load-bearing invariant — REFUSE to
// approve or reject without a recorded human identity (--by). Story/script
// text is inert data here — compared/echoed, never executed (§29).
import { describe, expect, it } from "vitest";

import {
  QC_SPEC,
  USAGE_QC,
  makeQcHandler,
  parseQcOptions,
  runQc,
  type HumanReviewRecordLike,
  type QcCommandPorts,
} from "./commands.js";

function record(overrides: Partial<HumanReviewRecordLike> = {}): HumanReviewRecordLike {
  return {
    shotId: "S01E01_SC04_SH07",
    episodeId: "S01E01",
    sceneId: "SC04",
    attempt: 1,
    trigger: "routes-exhausted",
    reason: "automated routes exhausted after agnes-flash → agnes-regular → seedance → wan — human review",
    routesTried: ["agnes-flash", "agnes-regular", "seedance", "wan"],
    state: "REVIEW",
    enteredAt: "2026-08-29T00:00:01.000Z",
    updatedAt: "2026-08-29T00:00:01.000Z",
    decidedAt: null,
    decidedBy: null,
    note: null,
    ...overrides,
  };
}

function makePorts(opts: { records?: HumanReviewRecordLike[] } = {}) {
  const records = (opts.records ?? [record()]).map((r) => ({ ...r }));
  const decisions: { shotId: string; verb: "approve" | "reject"; by: string }[] = [];
  const ports: QcCommandPorts = {
    listReviews: async (query) => {
      let out = [...records];
      if (query.episodeId !== undefined) out = out.filter((r) => r.episodeId === query.episodeId);
      if (query.includeResolved !== true) out = out.filter((r) => r.state === "REVIEW");
      return out;
    },
    approve: async (shotId, decision) => {
      const rec = records.find((r) => r.shotId === shotId);
      if (!rec || rec.state !== "REVIEW") throw new Error(`no open REVIEW record for ${shotId}`);
      decisions.push({ shotId, verb: "approve", by: decision.decidedBy });
      return { ...rec, state: "APPROVED", decidedBy: decision.decidedBy, decidedAt: "2026-08-29T01:00:00.000Z", note: decision.note ?? null };
    },
    reject: async (shotId, decision) => {
      const rec = records.find((r) => r.shotId === shotId);
      if (!rec || rec.state !== "REVIEW") throw new Error(`no open REVIEW record for ${shotId}`);
      decisions.push({ shotId, verb: "reject", by: decision.decidedBy });
      return { ...rec, state: "REJECTED", decidedBy: decision.decidedBy, decidedAt: "2026-08-29T01:00:00.000Z", note: decision.note ?? null };
    },
  };
  return { ports, decisions, records };
}

describe("parseQcOptions", () => {
  it("parses episode/by/note/all/json", () => {
    const o = parseQcOptions(["--episode", "S01E01", "--by", "trevor", "--note", "ok", "--all", "--json"]);
    expect(o.episode).toBe("S01E01");
    expect(o.by).toBe("trevor");
    expect(o.note).toBe("ok");
    expect(o.all).toBe(true);
    expect(o.json).toBe(true);
    expect(o.parseError).toBeUndefined();
  });

  it("rejects unknown flags, missing values, and loose words", () => {
    expect(parseQcOptions(["--bogus", "x"]).parseError).toMatch(/unknown option/);
    expect(parseQcOptions(["--by"]).parseError).toMatch(/requires a value/);
    expect(parseQcOptions(["loose-word"]).parseError).toMatch(/unexpected argument/);
  });
});

describe("runQc — listing (surface REVIEW items)", () => {
  it("default: lists open REVIEW items with why/routes/entered and exits 0", async () => {
    const { ports } = makePorts();
    const result = await runQc(undefined, [], [], ports);
    expect(result.exitCode).toBe(0);
    const text = result.lines.join("\n");
    expect(text).toContain("human REVIEW items: 1 open");
    expect(text).toContain("S01E01_SC04_SH07 (SC04)");
    expect(text).toContain("routes-exhausted");
    expect(text).toContain("agnes-flash → agnes-regular → seedance → wan");
    expect(text).toContain("nothing is auto-approved");
  });

  it("empty queue is exit 0 with zero rows — an empty review queue is not an error", async () => {
    const { ports } = makePorts({ records: [] });
    const result = await runQc(undefined, [], [], ports);
    expect(result.exitCode).toBe(0);
    expect(result.lines.join("\n")).toContain("0 open");
    expect(result.lines.join("\n")).toContain("no human REVIEW items");
  });

  it("--episode filters; resolved items stay hidden without --all and appear with it", async () => {
    const { ports } = makePorts({
      records: [
        record({ shotId: "A" }),
        record({ shotId: "B", episodeId: "S01E02" }),
        record({ shotId: "C", state: "APPROVED", decidedBy: "trevor", decidedAt: "2026-08-29T01:00:00.000Z" }),
      ],
    });
    const ep = await runQc(undefined, [], ["--episode", "S01E02"], ports);
    expect(ep.exitCode).toBe(0);
    expect(ep.lines.join("\n")).toContain("for S01E02");
    expect(ep.lines.join("\n")).toContain("1 open");
    expect(ep.lines.join("\n")).toContain("REVIEW B");
    const open = await runQc(undefined, [], [], ports);
    expect(open.lines.join("\n")).not.toContain("APPROVED");
    const all = await runQc(undefined, [], ["--all"], ports);
    expect(all.lines.join("\n")).toContain("APPROVED C");
  });

  it("--json emits a machine-readable listing with the open count", async () => {
    const { ports } = makePorts();
    const result = await runQc(undefined, [], ["--json"], ports);
    expect(result.exitCode).toBe(0);
    const json = result.json as { openCount: number; items: { shotId: string }[] };
    expect(json.openCount).toBe(1);
    expect(json.items[0]?.shotId).toBe("S01E01_SC04_SH07");
  });

  it("unknown subaction and bad options exit 2 with usage", async () => {
    const { ports } = makePorts();
    expect((await runQc("bogus", [], [], ports)).exitCode).toBe(2);
    expect((await runQc(undefined, [], ["--bogus", "x"], ports)).exitCode).toBe(2);
    expect((await runQc("bogus", [], [], ports)).lines).toContain(USAGE_QC);
  });
});

describe("runQc — approve/reject: NO SILENT AUTO-APPROVAL", () => {
  it("approve without --by exits 1, records nothing, store never touched", async () => {
    const { ports, decisions } = makePorts();
    const result = await runQc("approve", ["S01E01_SC04_SH07"], [], ports);
    expect(result.exitCode).toBe(1);
    expect(result.lines.join("\n")).toMatch(/--by <human> is required/);
    expect(result.lines.join("\n")).toMatch(/no auto-approval/);
    expect(decisions).toEqual([]);
  });

  it("approve with --by records the human decision and exits 0", async () => {
    const { ports, decisions } = makePorts();
    const result = await runQc(
      "approve",
      ["S01E01_SC04_SH07"],
      ["--by", "trevor", "--note", "flash footage reads fine"],
      ports,
    );
    expect(result.exitCode).toBe(0);
    expect(result.lines.join("\n")).toContain("APPROVED by trevor");
    expect(decisions).toEqual([{ shotId: "S01E01_SC04_SH07", verb: "approve", by: "trevor" }]);
  });

  it("reject with --by records the human rejection and the note", async () => {
    const { ports, decisions } = makePorts();
    const result = await runQc(
      "reject",
      ["S01E01_SC04_SH07"],
      ["--by", "trevor", "--note", "identity drift confirmed", "--json"],
      ports,
    );
    expect(result.exitCode).toBe(0);
    const json = result.json as { state: string; decidedBy: string; note: string | null };
    expect(json.state).toBe("REJECTED");
    expect(json.decidedBy).toBe("trevor");
    expect(json.note).toBe("identity drift confirmed");
    expect(decisions[0]?.verb).toBe("reject");
  });

  it("approve of an unknown shot surfaces the store error as exit 1", async () => {
    const { ports } = makePorts({ records: [] });
    const result = await runQc("approve", ["NOPE"], ["--by", "trevor"], ports);
    expect(result.exitCode).toBe(1);
    expect(result.lines.join("\n")).toMatch(/no open REVIEW record/);
  });

  it("approve without a shotId is a usage error (exit 2)", async () => {
    const { ports } = makePorts();
    expect((await runQc("approve", [], ["--by", "trevor"], ports)).exitCode).toBe(2);
  });
});

describe("dispatcher wiring", () => {
  it("QC_SPEC merges over the base registry and keeps the qc verb's group", () => {
    expect(QC_SPEC.name).toBe("qc");
    expect(QC_SPEC.group).toBe("generation");
  });

  it("makeQcHandler prints the listing to stdout and throws on rejection", async () => {
    const { ports } = makePorts({ records: [] });
    const writes: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      const handler = makeQcHandler(ports);
      await handler({}, {});
    } finally {
      process.stdout.write = orig;
    }
    expect(writes.join("")).toContain("no human REVIEW items");
  });
});
