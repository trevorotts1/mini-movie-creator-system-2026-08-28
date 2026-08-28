// CAP-009 acceptance tests — `mmcs providers verify` command wiring.
//
// The command layer must: load configured providers from env presence only
// (never values), accept injected registry/probes, produce the runbook §61
// report (configured vs documented vs observed + last verified + warnings),
// and never let a transient probe failure rewrite documented VERIFIED state.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  defaultProbes,
  loadConfiguredProviders,
  runProvidersVerify,
} from "./command.js";
import type { CapabilityProbe } from "./verify.js";
import {
  applyOverrides,
  observedOverrides,
  toDocumentedCapability,
  verifyProviders,
} from "./verify.js";

const NOW = "2026-08-28T13:20:00.000Z";

describe("loadConfiguredProviders (env presence only)", () => {
  it("marks credentials present/absent per provider without exposing values", () => {
    const configured = loadConfiguredProviders({
      AGNES_API_KEY: "secret-value-never-returned",
      OPENROUTER_API_KEY: "",
    });
    const byName = new Map(configured.map((c) => [c.provider, c]));
    expect(byName.get("agnes")?.credentialsPresent).toBe(true);
    // Empty-string key is NOT present.
    expect(byName.get("openrouter")?.credentialsPresent).toBe(false);
    expect(byName.get("kie")?.credentialsPresent).toBe(false);
    // No configured models invented — the registry supplies those.
    expect(byName.get("agnes")?.configuredModels).toEqual([]);
    // The loaded view never carries the secret itself.
    expect(JSON.stringify(configured)).not.toContain("never-returned");
  });
});

describe("runProvidersVerify", () => {
  it("end-to-end: agreement -> OK report with all three views", async () => {
    const probe: CapabilityProbe = async () => ({
      ok: true,
      observations: [{ field: "references.maxImages", value: 5, kind: "probed" }],
    });
    const out = await runProvidersVerify({
      now: () => NOW,
      configured: [
        { provider: "agnes", credentialsPresent: true, configuredModels: ["agnes-video-2.5-flash"] },
      ],
      registry: () => [
        {
          provider: "agnes",
          modelId: "agnes-video-2.5-flash",
          confidence: "VERIFIED",
          lastVerifiedAt: "2026-08-20T00:00:00.000Z",
          facts: { "references.maxImages": 5 },
        },
      ],
      probes: { agnes: probe },
    });
    expect(out.text).toContain("agnes/agnes-video-2.5-flash  OK  verified 2026-08-20");
    expect(out.result.reports[0]!.status).toBe("OK");
    expect(out.result.reports[0]!.verificationUsable).toBe(true);
  });

  it("end-to-end: mismatch -> discrepancy warning naming documented vs observed", async () => {
    const probe: CapabilityProbe = async () => ({
      ok: true,
      observations: [{ field: "references.maxImages", value: 10, kind: "probed" }],
    });
    const out = await runProvidersVerify({
      now: () => NOW,
      configured: [{ provider: "kie", credentialsPresent: true, configuredModels: ["wan-3.0"] }],
      registry: () => [
        {
          provider: "kie",
          modelId: "wan-3.0",
          confidence: "PROVISIONAL",
          lastVerifiedAt: "2026-07-01T00:00:00.000Z",
          facts: { "references.maxImages": 5 },
        },
      ],
      probes: { kie: probe },
    });
    expect(out.text).toContain("kie/wan-3.0  DISCREPANCY");
    expect(out.text).toContain("WARN [MISMATCH] references.maxImages");
    expect(out.text).toContain("runtime observed 10");
    expect(out.result.discrepancyCount).toBe(1);
  });

  it("transient probe failure keeps documented VERIFIED values and flags the run unusable", async () => {
    const probe: CapabilityProbe = async () => {
      throw new Error("socket hang up");
    };
    const out = await runProvidersVerify({
      now: () => NOW,
      configured: [{ provider: "agnes", credentialsPresent: true, configuredModels: ["m"] }],
      registry: () => [
        {
          provider: "agnes",
          modelId: "m",
          confidence: "VERIFIED",
          lastVerifiedAt: "2026-08-20T00:00:00.000Z",
          facts: { "references.maxImages": 5 },
        },
      ],
      probes: { agnes: probe },
    });
    expect(out.result.transientCount).toBe(1);
    expect(out.result.reports[0]!.documented.facts["references.maxImages"]).toBe(5);
    expect(out.result.reports[0]!.verificationUsable).toBe(false);
    expect(out.text).toContain("WARN [MISMATCH] *");
  });

  it("async registry loaders are awaited", async () => {
    const out = await runProvidersVerify({
      now: () => NOW,
      configured: [{ provider: "agnes", credentialsPresent: true, configuredModels: ["m"] }],
      registry: async () => [
        {
          provider: "agnes",
          modelId: "m",
          confidence: "UNKNOWN",
          lastVerifiedAt: null,
          facts: {},
        },
      ],
    });
    expect(out.result.reports[0]!.documented.confidence).toBe("UNKNOWN");
  });

  it("defaults work with zero configuration (scaffold state)", async () => {
    const out = await runProvidersVerify({
      now: () => NOW,
      configured: [],
      registry: () => [],
    });
    expect(out.result.reports).toHaveLength(0);
    expect(out.text).toContain("0 model(s) checked");
  });

  it("exposes an empty default probe set (no accidental network calls)", () => {
    expect(Object.keys(defaultProbes)).toHaveLength(0);
  });
});

describe("rootDir isolation (TS6059 regression guard)", () => {
  it("command sources never import @mmcs/capability-registry (CHAR-004 local-type pattern)", () => {
    const dir = fileURLToPath(new URL(".", import.meta.url));
    for (const file of ["command.ts", "command.test.ts", "verify.ts", "report.ts"]) {
      const src = readFileSync(new URL(file, import.meta.url), "utf8");
      expect(src, `${dir}${file} imports the workspace package`).not.toMatch(
        /from\s+["']@mmcs\/capability-registry["']/,
      );
    }
  });

  it("CLI package.json declares no workspace dependency (rootDir stays closed)", () => {
    const pkg = JSON.parse(
      readFileSync(
        fileURLToPath(new URL("../../../../../package.json", import.meta.url)),
        "utf8",
      ),
    ) as { dependencies?: Record<string, string> };
    expect(pkg.dependencies ?? {}).not.toHaveProperty(
      "@mmcs/capability-registry",
    );
  });
});

describe("CLI-local verify engine mirrors the package contract", () => {
  it("toDocumentedCapability narrows registry-shaped objects, never invents", () => {
    expect(toDocumentedCapability(null)).toBeNull();
    expect(toDocumentedCapability({})).toBeNull();
    expect(
      toDocumentedCapability({
        provider: "agnes",
        modelId: "m",
        confidence: "VERIFIED",
        lastVerifiedAt: "2026-08-20T00:00:00.000Z",
        facts: { "references.maxImages": 5 },
      }),
    ).toEqual({
      provider: "agnes",
      modelId: "m",
      confidence: "VERIFIED",
      lastVerifiedAt: "2026-08-20T00:00:00.000Z",
      facts: { "references.maxImages": 5 },
    });
  });

  it("applyOverrides never rewrites a VERIFIED fact and never mutates input", () => {
    const entries = [
      {
        provider: "agnes",
        modelId: "m",
        facts: { "references.maxImages": 5 as unknown },
        verifiedFacts: { "references.maxImages": true as const },
      },
    ];
    const snapshot = JSON.stringify(entries);
    const out = applyOverrides(entries, [
      {
        provider: "agnes",
        modelId: "m",
        field: "references.maxImages",
        value: 10,
        observedAt: NOW,
      },
    ]);
    expect(JSON.stringify(entries)).toBe(snapshot);
    expect(out[0]!.facts["references.maxImages"]).toBe(5);
  });

  it("observedOverrides includes only probed non-null observations", async () => {
    const flaky: CapabilityProbe = async () => ({ ok: false, error: "503" });
    const result = await verifyProviders(
      [{ provider: "agnes", credentialsPresent: true, configuredModels: ["m"] }],
      [{ provider: "agnes", modelId: "m", confidence: "VERIFIED", lastVerifiedAt: "2026-08-20T00:00:00.000Z", facts: {} }],
      { agnes: flaky },
      { now: () => NOW },
    );
    expect(observedOverrides(result)).toEqual([]);
  });
});