// CAP-009 acceptance tests — provider health/verify command.
//
// Covers the runbook §61 contract:
//   - reports configured vs documented vs runtime-observed capability,
//     last verified date, discrepancy warning;
//   - a transient probe failure NEVER silently rewrites VERIFIED capability
//     (the load-bearing rule): it adds a warning, records TRANSIENT, and
//     marks verificationUsable = false, while documented values stay put;
//   - only probed (non-transient) observations become CAP-010 overrides,
//     and applyOverrides never rewrites a VERIFIED fact nor mutates input.
import { describe, expect, it } from "vitest";
import {
  applyOverrides,
  observedOverrides,
  verifyProviders,
  type CapabilityProbe,
  type ConfiguredProvider,
  type DocumentedCapability,
} from "./verify.js";
import {
  formatVerifyReport,
  verifyResultToJson,
} from "./report.js";

const NOW = "2026-08-28T12:00:00.000Z";
const now = () => NOW;

function configured(
  provider: string,
  models: string[],
  credentialsPresent = true,
): ConfiguredProvider {
  return { provider, credentialsPresent, configuredModels: models };
}

function documented(
  provider: string,
  modelId: string,
  facts: Record<string, unknown>,
  overrides: Partial<Omit<DocumentedCapability, "provider" | "modelId">> = {},
): DocumentedCapability {
  return {
    provider,
    modelId,
    confidence: "VERIFIED",
    lastVerifiedAt: "2026-08-20T00:00:00.000Z",
    facts,
    ...overrides,
  };
}

describe("verifyProviders — configured vs documented vs observed", () => {
  it("reports all three views plus last verified date and status OK on agreement", async () => {
    const probe: CapabilityProbe = async () => ({
      ok: true,
      observations: [{ field: "references.maxImages", value: 5, kind: "probed" }],
    });
    const result = await verifyProviders(
      [configured("agnes", ["agnes-video-2.5-flash"])],
      [
        documented("agnes", "agnes-video-2.5-flash", {
          "references.maxImages": 5,
        }),
      ],
      { agnes: probe },
      { now },
    );
    expect(result.reports).toHaveLength(1);
    const report = result.reports[0]!;
    expect(report.status).toBe("OK");
    expect(report.discrepancies).toHaveLength(0);
    expect(report.verificationUsable).toBe(true);
    expect(report.verifiedAt).toBe(NOW);
    // configured view carried through verbatim
    expect(report.configured.credentialsPresent).toBe(true);
    expect(report.configured.configuredModels).toEqual([
      "agnes-video-2.5-flash",
    ]);
    // documented view carried through with its last-verified date
    expect(report.documented.lastVerifiedAt).toBe("2026-08-20T00:00:00.000Z");
    // observed view records the probed fact
    expect(report.observed).toEqual([
      { field: "references.maxImages", value: 5, kind: "probed" },
    ]);
    expect(result.discrepancyCount).toBe(0);
  });

  it("warns DISCREPANCY when runtime observation differs from documented capability", async () => {
    const probe: CapabilityProbe = async () => ({
      ok: true,
      observations: [{ field: "references.maxImages", value: 10, kind: "probed" }],
    });
    const result = await verifyProviders(
      [configured("kie", ["wan-3.0"])],
      [documented("kie", "wan-3.0", { "references.maxImages": 5 })],
      { kie: probe },
      { now },
    );
    const report = result.reports[0]!;
    expect(report.status).toBe("DISCREPANCY");
    expect(result.discrepancyCount).toBe(1);
    const d = report.discrepancies[0]!;
    expect(d.severity).toBe("MISMATCH");
    expect(d.field).toBe("references.maxImages");
    expect(d.documented).toBe(5);
    expect(d.observed).toBe(10);
    expect(d.message).toContain("documented");
  });

  it("flags UNDOCUMENTED when the runtime sees a fact the registry lacks", async () => {
    const probe: CapabilityProbe = async () => ({
      ok: true,
      observations: [
        { field: "output.resolutions", value: "720p", kind: "probed" },
      ],
    });
    const result = await verifyProviders(
      [configured("agnes", ["agnes-video-2.5"])],
      [documented("agnes", "agnes-video-2.5", {})],
      { agnes: probe },
      { now },
    );
    const d = result.reports[0]!.discrepancies[0]!;
    expect(d.severity).toBe("UNDOCUMENTED");
    expect(d.field).toBe("output.resolutions");
  });

  it("flags STALE when the documented lastVerifiedAt is older than the limit", async () => {
    const result = await verifyProviders(
      [configured("agnes", ["m"])],
      [
        documented("agnes", "m", { "references.maxImages": 5 }, {
          lastVerifiedAt: "2026-01-01T00:00:00.000Z",
        }),
      ],
      {},
      { now, staleDays: 30 },
    );
    const d = result.reports[0]!.discrepancies[0]!;
    expect(d.severity).toBe("STALE");
    expect(d.field).toBe("lastVerifiedAt");
    // UNKNOWN profiles are never stale-flagged (nothing was ever verified).
    const unknown = await verifyProviders(
      [configured("agnes", ["u"])],
      [
        documented("agnes", "u", {}, {
          confidence: "UNKNOWN",
          lastVerifiedAt: null,
        }),
      ],
      {},
      { now },
    );
    expect(unknown.reports[0]!.discrepancies).toHaveLength(0);
  });

  it("records skipped observation and stays OK when no probe is registered", async () => {
    const result = await verifyProviders(
      [configured("fish", ["fish-voice"])],
      [documented("fish", "fish-voice", { "output.audioGenerationSupported": true })],
      {},
      { now },
    );
    const report = result.reports[0]!;
    expect(report.observed).toEqual([{ field: "*", value: null, kind: "skipped" }]);
    expect(report.status).toBe("OK");
  });

  it("treats an undocumented model as UNKNOWN with empty facts (no invention)", async () => {
    const result = await verifyProviders(
      [configured("agnes", ["not-in-registry"])],
      [],
      {},
      { now },
    );
    const report = result.reports[0]!;
    expect(report.documented.confidence).toBe("UNKNOWN");
    expect(report.documented.facts).toEqual({});
    expect(report.documented.lastVerifiedAt).toBeNull();
  });
});

describe("transient failures never silently rewrite VERIFIED (runbook §61)", () => {
  it("a throwing probe is recorded TRANSIENT, documented values stay, run is unusable", async () => {
    const probe: CapabilityProbe = async () => {
      throw new Error("ECONNRESET: network blip");
    };
    const doc = documented("agnes", "agnes-video-2.5-flash", {
      "references.maxImages": 5,
      "output.maxDurationSeconds": 12,
    });
    const result = await verifyProviders(
      [configured("agnes", ["agnes-video-2.5-flash"])],
      [doc],
      { agnes: probe },
      { now },
    );
    const report = result.reports[0]!;
    expect(result.transientCount).toBe(1);
    // The observation says TRANSIENT — it is not an observed capability value.
    expect(report.observed).toEqual([
      { field: "*", value: null, kind: "transient", error: "ECONNRESET: network blip" },
    ]);
    // Documented capability untouched.
    expect(report.documented).toBe(doc);
    expect(report.documented.facts["references.maxImages"]).toBe(5);
    expect(report.documented.confidence).toBe("VERIFIED");
    // Warning surfaced, verification marked unusable.
    expect(report.status).toBe("DISCREPANCY");
    expect(report.verificationUsable).toBe(false);
    expect(report.discrepancies[0]!.message).toContain("transient");
    expect(report.discrepancies[0]!.message).toContain("never rewrites VERIFIED");
  });

  it("a probe-reported failure (not a throw) is TRANSIENT with the same guarantees", async () => {
    const probe: CapabilityProbe = async () => ({
      ok: false,
      error: "provider 503 Service Unavailable",
    });
    const result = await verifyProviders(
      [configured("kie", ["wan-3.0"])],
      [documented("kie", "wan-3.0", { "references.maxImages": 10 })],
      { kie: probe },
      { now },
    );
    const report = result.reports[0]!;
    expect(report.observed[0]!.kind).toBe("transient");
    expect(report.verificationUsable).toBe(false);
    expect(report.documented.facts["references.maxImages"]).toBe(10);
  });

  it("a hanging probe is downgraded to TRANSIENT by the timeout", async () => {
    const probe: CapabilityProbe = () => new Promise(() => undefined);
    const result = await verifyProviders(
      [configured("agnes", ["m"])],
      [documented("agnes", "m", { "references.maxImages": 5 })],
      { agnes: probe },
      { now, timeoutMs: 30 },
    );
    const report = result.reports[0]!;
    expect(report.observed[0]!.kind).toBe("transient");
    expect(report.observed[0]!.error).toContain("timed out");
    expect(report.verificationUsable).toBe(false);
    expect(report.documented.facts["references.maxImages"]).toBe(5);
  });

  it("a transient observation never reaches the CAP-010 override stream", async () => {
    const flaky: CapabilityProbe = async () => ({
      ok: false,
      error: "503",
    });
    const result = await verifyProviders(
      [configured("agnes", ["m"])],
      [documented("agnes", "m", { "references.maxImages": 5 })],
      { agnes: flaky },
      { now },
    );
    expect(observedOverrides(result)).toEqual([]);
  });

  it("a per-field transient observation downgrades usability without inventing values", async () => {
    const probe: CapabilityProbe = async () => ({
      ok: true,
      observations: [
        { field: "references.maxImages", value: 5, kind: "probed" },
        { field: "output.maxDurationSeconds", value: null, kind: "transient", error: "rate limited" },
      ],
    });
    const result = await verifyProviders(
      [configured("agnes", ["m"])],
      [documented("agnes", "m", { "references.maxImages": 5, "output.maxDurationSeconds": 12 })],
      { agnes: probe },
      { now },
    );
    const report = result.reports[0]!;
    expect(report.verificationUsable).toBe(false);
    // The probed field agrees; the transient field produced a warning only.
    expect(report.discrepancies.some((d) => d.field === "output.maxDurationSeconds")).toBe(true);
    expect(report.discrepancies.some((d) => d.field === "references.maxImages")).toBe(false);
  });
});

describe("observedOverrides + applyOverrides", () => {
  it("emits overrides only for probed, non-null observations", async () => {
    const probe: CapabilityProbe = async () => ({
      ok: true,
      observations: [
        { field: "references.maxImages", value: 10, kind: "probed" },
        { field: "output.maxDurationSeconds", value: null, kind: "probed" },
        { field: "*", value: null, kind: "skipped" },
      ],
    });
    const result = await verifyProviders(
      [configured("kie", ["wan-3.0"])],
      [documented("kie", "wan-3.0", { "references.maxImages": 5 })],
      { kie: probe },
      { now },
    );
    const overrides = observedOverrides(result);
    expect(overrides).toEqual([
      {
        provider: "kie",
        modelId: "wan-3.0",
        field: "references.maxImages",
        value: 10,
        observedAt: NOW,
      },
    ]);
  });

  it("applyOverrides returns new objects, never mutates the input registry", () => {
    const entries = [
      {
        provider: "kie",
        modelId: "wan-3.0",
        facts: { "references.maxImages": 5 as unknown },
      },
    ];
    const snapshot = JSON.stringify(entries);
    const out = applyOverrides(entries, [
      {
        provider: "kie",
        modelId: "wan-3.0",
        field: "references.maxImages",
        value: 10,
        observedAt: NOW,
      },
    ]);
    expect(JSON.stringify(entries)).toBe(snapshot); // input untouched
    expect(out[0]!.facts["references.maxImages"]).toBe(10);
    expect(entries[0]!.facts["references.maxImages"]).toBe(5);
  });

  it("applyOverrides never rewrites a fact marked VERIFIED", () => {
    const entries = [
      {
        provider: "agnes",
        modelId: "m",
        facts: { "references.maxImages": 5 as unknown },
        verifiedFacts: { "references.maxImages": true as const },
      },
    ];
    const out = applyOverrides(entries, [
      {
        provider: "agnes",
        modelId: "m",
        field: "references.maxImages",
        value: 10,
        observedAt: NOW,
      },
    ]);
    expect(out[0]!.facts["references.maxImages"]).toBe(5);
  });

  it("applyOverrides fills undocumented fields and ignores unknown models", () => {
    const entries = [
      { provider: "agnes", modelId: "m", facts: {} },
    ];
    const out = applyOverrides(entries, [
      { provider: "agnes", modelId: "m", field: "output.resolutions", value: ["720p"], observedAt: NOW },
      { provider: "ghost", modelId: "x", field: "references.maxImages", value: 1, observedAt: NOW },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.facts["output.resolutions"]).toEqual(["720p"]);
  });
});

describe("report formatting (runbook §61 output)", () => {
  it("formats model lines, warnings, and the summary line", async () => {
    const probe: CapabilityProbe = async () => ({
      ok: true,
      observations: [{ field: "references.maxImages", value: 10, kind: "probed" }],
    });
    const result = await verifyProviders(
      [configured("kie", ["wan-3.0"]), configured("agnes", ["flash"])],
      [
        documented("kie", "wan-3.0", { "references.maxImages": 5 }),
        documented("agnes", "flash", { "references.maxImages": 5 }),
      ],
      { kie: probe },
      { now },
    );
    const text = formatVerifyReport(result);
    expect(text).toContain("mmcs providers verify — 2 model(s) checked");
    expect(text).toContain("kie/wan-3.0  DISCREPANCY  verified 2026-08-20");
    expect(text).toContain("agnes/flash  OK  verified 2026-08-20");
    expect(text).toContain("WARN [MISMATCH] references.maxImages");
    expect(text.endsWith("1 of 2 model(s) with discrepancies; 0 transient probe failure(s)")).toBe(true);
  });

  it("JSON view is stable and complete", async () => {
    const result = await verifyProviders(
      [configured("agnes", ["m"], false)],
      [documented("agnes", "m", { "references.maxImages": 5 })],
      {},
      { now },
    );
    const json = verifyResultToJson(result) as Record<string, unknown>;
    expect(json.verifiedAt).toBe(NOW);
    const summary = json.summary as Record<string, unknown>;
    expect(summary.models).toBe(1);
    const reports = json.reports as Array<Record<string, unknown>>;
    expect(reports[0]!.configured).toEqual({
      credentialsPresent: false,
      configuredModels: ["m"],
    });
    expect((reports[0]!.documented as Record<string, unknown>).confidence).toBe("VERIFIED");
  });
});