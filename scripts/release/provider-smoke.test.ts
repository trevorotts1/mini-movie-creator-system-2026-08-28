import { describe, expect, it, afterEach } from "vitest";
import {
  FIXTURE_PROJECTIONS_USD,
  PROVIDER_ENV_VARS,
  SMOKE_DEFAULT_LIMIT_USD,
  SMOKE_HARD_CAP_USD,
  SmokeBudget,
  SmokeSpendGateExceededError,
  credentialsPresent,
  printResult,
  renderSmokeMarkdown,
  runProviderSmoke,
} from "./provider-smoke.js";
import type { ProviderName } from "./provider-smoke.js";

const ALL_PROVIDERS = Object.keys(PROVIDER_ENV_VARS) as ProviderName[];

describe("env-gating decisions (presence on NAMES only, never values)", () => {
  afterEach(() => {
    delete process.env["MMCS_SMOKE_LIVE"];
    delete process.env["MMCS_SMOKE_COST_ACK"];
  });

  it("all four providers are gated by env-var presence", () => {
    expect(ALL_PROVIDERS.sort()).toEqual(["agnes", "fish", "ghl", "kie"]);
  });

  it("credential vars mirror the engine's MMCS_ENV_KEYS (no inherited Python-tools keys)", () => {
    // Engine single source of truth — a provider must not gate on FAL_KEY /
    // FISH_AUDIO_API_KEY, which belong to the inherited tools, not MMCS.
    expect(PROVIDER_ENV_VARS.agnes).toEqual(["AGNES_API_KEY"]);
    expect(PROVIDER_ENV_VARS.kie).toEqual(["KIE_API_KEY"]);
    expect(PROVIDER_ENV_VARS.fish).toEqual(["FISH_API_KEY"]);
    expect(PROVIDER_ENV_VARS.ghl).toEqual(["GHL_ACCESS_TOKEN", "GHL_LOCATION_ID"]);
    const flattened = Object.values(PROVIDER_ENV_VARS).flat();
    expect(flattened).not.toContain("FAL_KEY");
    expect(flattened).not.toContain("FISH_AUDIO_API_KEY");
    expect(flattened).not.toContain("ELEVENLABS_API_KEY");
    expect(flattened).not.toContain("GEMINI_API_KEY");
  });

  it("agnes is CREDENTIALED when any of its vars is non-blank", () => {
    const env = { AGNES_API_KEY: "  x  " };
    expect(credentialsPresent(env, PROVIDER_ENV_VARS.agnes)).toBe(true);
    const result = runProviderSmoke({ env, forceMock: true, reportOnly: false });
    const agnes = result.providers.find((p) => p.provider === "agnes")!;
    expect(agnes.credentialsPresent).toBe(true);
  });

  it("inherited-tools key FAL_KEY alone never credentials a provider (spec §30)", () => {
    const env: Record<string, string | undefined> = { FAL_KEY: "fal-inherited-tools-key" };
    const result = runProviderSmoke({ env });
    for (const p of result.providers) {
      expect(p.credentialsPresent).toBe(false);
      expect(p.mode).toBe("BLOCKED");
    }
  });

  it("blank-only credentials count as absent", () => {
    const env = { KIE_API_KEY: "   " };
    const result = runProviderSmoke({ env, forceMock: true });
    const kie = result.providers.find((p) => p.provider === "kie")!;
    expect(kie.credentialsPresent).toBe(false);
    expect(kie.mode).toBe("BLOCKED");
  });

  it("credential-absent providers are BLOCKED and never marked LIVE PASS", () => {
    const result = runProviderSmoke({ env: {} });
    for (const p of result.providers) {
      expect(p.credentialsPresent).toBe(false);
      expect(p.mode).toBe("BLOCKED");
      expect(p.liveStatus).not.toBe("PASS");
    }
  });

  it("present credentials without MMCS_SMOKE_LIVE=1 stay MOCKED/BLOCKED", () => {
    const env: Record<string, string | undefined> = {};
    for (const vars of Object.values(PROVIDER_ENV_VARS)) env[vars[0]!] = "x";
    const result = runProviderSmoke({ env, reportOnly: false });
    for (const p of result.providers) {
      expect(p.mode).toBe("MOCKED");
      expect(p.liveStatus).toBe("BLOCKED");
    }
  });

  it("MMCS_SMOKE_LIVE=1 WITHOUT a non-empty MMCS_SMOKE_COST_ACK never goes LIVE", () => {
    const env: Record<string, string | undefined> = { MMCS_SMOKE_LIVE: "1" };
    for (const vars of Object.values(PROVIDER_ENV_VARS)) env[vars[0]!] = "x";
    const noAck = runProviderSmoke({ env, reportOnly: false });
    for (const p of noAck.providers) {
      expect(p.mode).not.toBe("LIVE");
      expect(p.liveStatus).not.toBe("PASS");
    }
    // Blank ack is not consent.
    const envBlank = { ...env, MMCS_SMOKE_COST_ACK: "   " };
    const blankAck = runProviderSmoke({ env: envBlank, reportOnly: false });
    for (const p of blankAck.providers) {
      expect(p.mode).not.toBe("LIVE");
    }
    // Non-empty ack + opt-in + creds + not-report-only satisfies the gate
    // arithmetic, but no live executor exists here → NOT_RUN, never PASS.
    const envAck = { ...env, MMCS_SMOKE_COST_ACK: "spend approved for smoke" };
    const full = runProviderSmoke({ env: envAck, reportOnly: false });
    for (const p of full.providers) {
      expect(p.mode).toBe("LIVE");
      expect(p.liveStatus).toBe("NOT_RUN");
      expect(p.liveStatus).not.toBe("PASS");
    }
  });

  it("report-only mode can never emit LIVE or liveStatus PASS even with full opt-in", () => {
    const env: Record<string, string | undefined> = {
      MMCS_SMOKE_LIVE: "1",
      MMCS_SMOKE_COST_ACK: "ack",
    };
    for (const vars of Object.values(PROVIDER_ENV_VARS)) env[vars[0]!] = "x";
    const result = runProviderSmoke({ env, reportOnly: true });
    for (const p of result.providers) {
      expect(p.mode).toBe("MOCKED");
      expect(p.liveStatus).toBe("BLOCKED");
    }
  });
});

describe("gate arithmetic ($25 envelope, MIN-only override)", () => {
  it("report-only projection is always $0 and the run exits within the gate", () => {
    const result = runProviderSmoke({ env: {} });
    expect(result.projectedFullRunUsd).toBe(0);
    expect(result.totalSpendUsd).toBe(0);
    expect(result.limitUsd).toBe(SMOKE_DEFAULT_LIMIT_USD);
    expect(result.ok).toBe(true);
    expect(result.providers).toHaveLength(4);
  });

  it("MMCS_SMOKE_LIMIT_USD may only LOWER the $25 cap", () => {
    const low = runProviderSmoke({ env: { MMCS_SMOKE_LIMIT_USD: "5" } });
    expect(low.limitUsd).toBe(5);
    const high = runProviderSmoke({ env: { MMCS_SMOKE_LIMIT_USD: "99999" } });
    expect(high.limitUsd).toBe(SMOKE_HARD_CAP_USD);
    const junk = runProviderSmoke({ env: { MMCS_SMOKE_LIMIT_USD: "not-a-number" } });
    expect(junk.limitUsd).toBe(SMOKE_DEFAULT_LIMIT_USD);
  });

  it("SmokeBudget trips BEFORE a call over the envelope", () => {
    const gate = new SmokeBudget(25);
    gate.assertWithinGate(20);
    gate.recordSpend(20);
    expect(() => gate.assertWithinGate(10)).toThrow(SmokeSpendGateExceededError);
    try {
      gate.assertWithinGate(10);
    } catch (err) {
      expect((err as SmokeSpendGateExceededError).projectedUsd).toBeCloseTo(30);
      expect((err as SmokeSpendGateExceededError).limitUsd).toBe(25);
    }
  });

  it("fixture projections stay far under the $25 cap", () => {
    const total = Object.values(FIXTURE_PROJECTIONS_USD).reduce((s, v) => s + v, 0);
    expect(total).toBeGreaterThan(0);
    expect(total).toBeLessThan(SMOKE_HARD_CAP_USD);
  });
});

describe("report output", () => {
  it("print + markdown report record spend $0, jobs 'none (mocked)', BLOCKED marks", () => {
    const result = runProviderSmoke({ env: {} });
    const printed = printResult(result).join("\n");
    expect(printed).toContain("jobs=none (mocked)");
    expect(printed).toContain("spend=$0.0000");
    const md = renderSmokeMarkdown(result);
    expect(md).toContain("none (mocked)");
    expect(md).toContain("**BLOCKED**".replace("**BLOCKED**", "BLOCKED"));
    expect(md).toContain("spend recorded this run: $0.0000");
    expect(md).not.toMatch(/(sk-[A-Za-z0-9]|Bearer\s)/);
  });
});