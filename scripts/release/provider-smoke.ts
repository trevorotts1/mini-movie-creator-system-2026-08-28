/// <reference types="node" />
/**
 * provider-smoke.ts — REL-005: minimal provider smoke (spec §30).
 *
 * `--report-only` (the build-run default) is a ZERO-SPEND credential-gating
 * pass: for each provider it decides CREDENTIALED vs MOCKED/BLOCKED by
 * ENV-VAR PRESENCE ONLY (never reads or prints secret values), enforces the
 * §4 $25 spend-gate arithmetic (the projection in report-only mode is always
 * $0), and exits 0. No network, no paid calls — the ABORT RULE for this build.
 *
 * Live gating (kept for later runs): a provider is LIVE only when its
 * credential env vars are present AND MMCS_SMOKE_LIVE=1 is exported. The
 * envelope is MIN(MMCS_SMOKE_LIMIT_USD ?? 25, 25) — the override may only
 * LOWER the $25 cap, never raise it.
 *
 * Secrets: env var NAMES only in output. Prompt strings are untrusted data —
 * never executed (spec §29).
 */

export const SMOKE_HARD_CAP_USD = 25;
export const SMOKE_DEFAULT_LIMIT_USD = 25;

/**
 * Per-provider credential env vars (NAMES only — values never read into output).
 * Mirrors the engine's single source of truth `MMCS_ENV_KEYS`
 * (packages/core/src/config/schema.ts): agnes→AGNES_API_KEY, kie→KIE_API_KEY,
 * fish→FISH_API_KEY, ghl→GHL_ACCESS_TOKEN+GHL_LOCATION_ID. Inherited Python-tools
 * vars (FAL_KEY, ELEVENLABS_API_KEY, GEMINI_API_KEY) are NOT engine credentials —
 * their presence alone must never gate a provider.
 */
export const PROVIDER_ENV_VARS: Record<ProviderName, readonly string[]> = {
  agnes: ["AGNES_API_KEY"],
  kie: ["KIE_API_KEY"],
  fish: ["FISH_API_KEY"],
  ghl: ["GHL_ACCESS_TOKEN", "GHL_LOCATION_ID"],
};

export type ProviderName = "agnes" | "kie" | "fish" | "ghl";
export type ProviderMode = "LIVE" | "MOCKED" | "BLOCKED";
/**
 * Live-item outcome. "PASS" is reachable only when the provider actually
 * completed a live call with recorded job IDs — this script (report-only)
 * can never emit it, so a credential-absent or not-executed live item is
 * never falsely passed (spec §30).
 */
export type LiveStatus = "PASS" | "BLOCKED" | "FAILED" | "NOT_RUN";

export interface ProviderOutcome {
  provider: ProviderName;
  credentialEnvVars: readonly string[];
  credentialsPresent: boolean;
  mode: ProviderMode;
  liveStatus: LiveStatus;
  /** Fixture projection if this provider ran live (USD, list pricing). */
  projectedUsd: number;
  /** Spend this run — always $0 in report-only mode. */
  spendUsd: number;
  /** Job IDs: `none (mocked)` in report-only mode. */
  jobIds: Record<string, string>;
}

export interface SmokeResult {
  ok: boolean;
  reportOnly: boolean;
  limitUsd: number;
  projectedFullRunUsd: number;
  totalSpendUsd: number;
  liveOptIn: boolean;
  providers: ProviderOutcome[];
}

/** Fixture projections (USD, worst-case list pricing) — used only outside report-only. */
export const FIXTURE_PROJECTIONS_USD: Record<ProviderName, number> = {
  agnes: 4 * 0.025, // agnes-video-2.5-flash: $0.025 / output second (4s)
  kie: 4 * 0.019, // seedance-2-mini 480p text-to-video: $0.019 / s (4s)
  fish: 0.001, // tiny text, far under the $15/1M-UTF8 rate
  ghl: 0, // media storage: no metered generation spend
};

// ---------------------------------------------------------------------------
// Env gating — presence checks on NAMES only
// ---------------------------------------------------------------------------

/** True when ANY of the provider's vars is present and non-blank. */
export function credentialsPresent(
  env: Record<string, string | undefined>,
  vars: readonly string[],
): boolean {
  return vars.some((v) => typeof env[v] === "string" && env[v]!.trim() !== "");
}

function resolveLimitUsd(env: Record<string, string | undefined>): number {
  const raw = env["MMCS_SMOKE_LIMIT_USD"];
  const parsed = raw !== undefined && raw.trim() !== "" ? Number(raw) : NaN;
  const requested = Number.isFinite(parsed) && parsed > 0 ? parsed : SMOKE_DEFAULT_LIMIT_USD;
  // The override may only LOWER the §4 $25 cap, never raise it.
  return Math.max(0.01, Math.min(requested, SMOKE_HARD_CAP_USD));
}

// ---------------------------------------------------------------------------
// Cost gate — the $25 arithmetic
// ---------------------------------------------------------------------------

/** Thrown BEFORE a paid call when the projection would cross the envelope. */
export class SmokeSpendGateExceededError extends Error {
  constructor(
    readonly projectedUsd: number,
    readonly limitUsd: number,
    readonly spentUsd: number,
  ) {
    super(
      `smoke spend gate: projected $${projectedUsd.toFixed(4)} exceeds the $${limitUsd.toFixed(
        2,
      )} envelope ($${spentUsd.toFixed(4)} spent this run)`,
    );
    this.name = "SmokeSpendGateExceededError";
  }
}

export class SmokeBudget {
  private spentCents = 0;
  constructor(readonly limitUsd: number) {}

  /** HARD pre-call check: never fire a request over the envelope. */
  assertWithinGate(thisCallUsd: number): void {
    const projected = roundUsd(this.spentUsd + thisCallUsd);
    if (projected > this.limitUsd + 1e-9) {
      throw new SmokeSpendGateExceededError(projected, this.limitUsd, this.spentUsd);
    }
  }

  get spentUsd(): number {
    return roundUsd(this.spentCents / 100);
  }

  recordSpend(usd: number): void {
    this.spentCents += Math.round(usd * 100);
  }
}

function roundUsd(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface RunSmokeOptions {
  /** Zero-spend gating pass (the build default). Projection is always $0. */
  reportOnly?: boolean;
  /** Injected env (tests); defaults to process.env. */
  env?: Record<string, string | undefined>;
  forceMock?: boolean;
}

export function runProviderSmoke(
  options: RunSmokeOptions = {},
): SmokeResult {
  const reportOnly = options.reportOnly ?? true;
  const env = options.env ?? process.env;
  const forceMock = options.forceMock ?? false;
  // Live requires BOTH the opt-in flag AND an explicit non-empty cost
  // acknowledgment — the consent path for real spend (spec §33). The ack value
  // is never echoed anywhere in output.
  const liveOptIn =
    !forceMock &&
    env["MMCS_SMOKE_LIVE"] === "1" &&
    typeof env["MMCS_SMOKE_COST_ACK"] === "string" &&
    env["MMCS_SMOKE_COST_ACK"].trim() !== "";
  const limitUsd = resolveLimitUsd(env);

  // Gate arithmetic: the whole-run projection must sit inside the envelope.
  const projectedFullRunUsd = reportOnly
    ? 0
    : roundUsd(Object.values(FIXTURE_PROJECTIONS_USD).reduce((s, v) => s + v, 0));
  const gate = new SmokeBudget(limitUsd);
  gate.assertWithinGate(projectedFullRunUsd);

  const providers: ProviderOutcome[] = (Object.keys(PROVIDER_ENV_VARS) as ProviderName[]).map(
    (provider) => {
      const vars = PROVIDER_ENV_VARS[provider];
      const present = credentialsPresent(env, vars);
      const live = liveOptIn && present && !reportOnly;
      const mode: ProviderMode = live ? "LIVE" : present ? "MOCKED" : "BLOCKED";
      return {
        provider,
        credentialEnvVars: vars,
        credentialsPresent: present,
        mode,
        // spec §30 honesty: no live executor exists in this script, so a live
        // item is NEVER "PASS" here — at most NOT_RUN, and absent credentials
        // are BLOCKED.
        liveStatus: live ? "NOT_RUN" : "BLOCKED",
        projectedUsd: reportOnly ? 0 : FIXTURE_PROJECTIONS_USD[provider],
        spendUsd: 0,
        jobIds: {},
      };
    },
  );

  return {
    ok: true,
    reportOnly,
    limitUsd,
    projectedFullRunUsd,
    totalSpendUsd: 0,
    liveOptIn,
    providers,
  };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export function renderSmokeMarkdown(result: SmokeResult): string {
  const lines: string[] = [];
  lines.push(
    "<!-- AUTO-GENERATED by scripts/release/provider-smoke.ts --report-only — do not edit by hand. -->",
  );
  lines.push("");
  lines.push("# MMCS Minimal Provider Smoke Report (REL-005)");
  lines.push("");
  lines.push("**Mode: report-only (zero-spend credential-gating pass — no live paid calls).**");
  lines.push("");
  lines.push(`**Result: ${result.ok ? "PASS" : "FAIL"}**`);
  lines.push("");
  lines.push(`- spend envelope: $${result.limitUsd.toFixed(2)} (hard §4 cap $25.00)`);
  lines.push(`- projection this run: $${result.projectedFullRunUsd.toFixed(4)}`);
  lines.push(`- spend recorded this run: $${result.totalSpendUsd.toFixed(4)}`);
  lines.push(
    `- live opt-in (MMCS_SMOKE_LIVE=1 + MMCS_SMOKE_COST_ACK): ${result.liveOptIn ? "yes" : "no"}`,
  );
  lines.push("");
  lines.push("## Per-provider outcomes");
  lines.push("");
  lines.push("| Provider | Credential env vars | Credentials | Mode | Live item | Spend | Job IDs |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const p of result.providers) {
    const jobIds =
      Object.keys(p.jobIds).length === 0 ? "none (mocked)" : JSON.stringify(p.jobIds);
    lines.push(
      `| ${p.provider} | ${p.credentialEnvVars.join(", ")} | ${
        p.credentialsPresent ? "present" : "absent"
      } | ${p.mode} | ${p.liveStatus} | $${p.spendUsd.toFixed(4)} | ${jobIds} |`,
    );
  }
  lines.push("");
  lines.push("## Honesty notes (spec §30)");
  lines.push("");
  for (const p of result.providers) {
    if (p.mode === "BLOCKED") {
      lines.push(
        `- **${p.provider}**: BLOCKED — credential env vars absent (${p.credentialEnvVars.join(
          ", ",
        )}). Mocked; live API behavior is NOT covered and is NOT reported as covered.`,
      );
    } else if (p.mode === "MOCKED") {
      lines.push(
        `- **${p.provider}**: credential(s) present-by-name but run is report-only — marked MOCKED/BLOCKED for the live smoke item; no live call was made.`,
      );
    } else {
      lines.push(`- **${p.provider}**: LIVE gate satisfied (credentials name-present + opt-in + cost ack) — but this script executes no live calls; live item NOT_RUN until a live executor records real job IDs.`);
    }
  }
  lines.push("");
  lines.push(
    "Cost control: projection in report-only mode is always $0; the envelope is MIN(MMCS_SMOKE_LIMIT_USD ?? 25, 25) — the override can only lower the §4 $25 cap. Every provider without credentials is marked BLOCKED, never falsely passed.",
  );
  lines.push("");
  return lines.join("\n");
}

export function writeSmokeReport(repoRoot: string, markdown: string): string {
  const target = `${repoRoot.replace(/\/+$/, "")}/docs/provider-smoke-report.md`;
  const { mkdirSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
  mkdirSync(`${repoRoot.replace(/\/+$/, "")}/docs`, { recursive: true });
  writeFileSync(target, markdown, "utf8");
  return target;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function printResult(result: SmokeResult): string[] {
  const lines: string[] = [];
  lines.push("=== MMCS minimal provider smoke (REL-005) — report-only ===");
  for (const p of result.providers) {
    const state =
      p.mode === "LIVE" ? "CREDENTIALED" : p.credentialsPresent ? "MOCKED/BLOCKED" : "MOCKED/BLOCKED";
    lines.push(
      `${state} ${p.provider}: creds(${p.credentialEnvVars.join(",")})=${
        p.credentialsPresent ? "present" : "absent"
      } projection=$${p.projectedUsd.toFixed(4)} spend=$${p.spendUsd.toFixed(4)} jobs=${
        Object.keys(p.jobIds).length === 0 ? "none (mocked)" : JSON.stringify(p.jobIds)
      }`,
    );
  }
  lines.push(
    `gate: envelope $${result.limitUsd.toFixed(2)} · projection $${result.projectedFullRunUsd.toFixed(
      4,
    )} · spend $${result.totalSpendUsd.toFixed(4)} → within gate`,
  );
  return lines;
}

/** CLI entry: report-only smoke always exits 0 (no FAIL/HALTED possible). */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const { fileURLToPath } = await import("node:url");
  const { resolve, dirname, join } = await import("node:path");
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const reportOnly = !argv.includes("--live");
  const result = runProviderSmoke({ reportOnly });
  for (const line of printResult(result)) process.stdout.write(`${line}\n`);
  if (argv.includes("--markdown") || argv.includes("--report-only")) {
    const target = writeSmokeReport(repoRoot, renderSmokeMarkdown(result));
    process.stdout.write(`report written: ${target}\n`);
  }
  return 0;
}

// Executed directly: run + exit.
const entry = process.argv[1];
if (entry) {
  import("node:url")
    .then(({ fileURLToPath }) => {
      import("node:path").then(({ resolve }) => {
        if (fileURLToPath(import.meta.url) === resolve(entry)) return main();
        return undefined;
      });
    })
    .then((code) => {
      if (typeof code === "number") process.exitCode = code;
    });
}