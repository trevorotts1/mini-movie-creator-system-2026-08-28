/**
 * CAP-009 — `mmcs providers verify` command wiring (runbook §61, spec §24).
 *
 * Owns only this directory (apps/cli/src/commands/providers-verify/). The
 * CLI entry (src/index.ts, CORE-011's) gains the real verb via a one-line
 * import at integration; that file is NOT owned by CAP-009.
 *
 * The command:
 *   1. reads the operator's provider configuration through an injected
 *      loader (no filesystem access at module import time — testable);
 *   2. reads documented capability profiles through an injected registry
 *      loader;
 *   3. runs safe runtime probes where a probe is registered (never a paid
 *      generation call);
 *   4. reports configured vs documented vs runtime-observed capability,
 *      last verified date, and discrepancy warnings;
 *   5. NEVER rewrites a VERIFIED documented capability from a transient
 *      probe failure — transient observations only ever add a warning and
 *      mark the verification unusable.
 *
 * Default loader reads the repo's provider env contract only (which provider
 * keys are present — never their values) so `mmcs providers verify` works
 * with zero external dependencies. Callers/tests inject richer loaders.
 */

import {
  verifyProviders,
  formatVerifyReport,
  verifyResultToJson,
  type CapabilityProbe,
  type ConfiguredProvider,
  type DocumentedCapability,
  type ProviderVerifyResult,
  type VerifyOptions,
} from "@mmcs/capability-registry";

/** Which env var names gate each provider's "configured" state. */
export const PROVIDER_ENV_KEYS: Readonly<Record<string, readonly string[]>> = {
  agnes: ["AGNES_API_KEY"],
  kie: ["KIE_API_KEY"],
  fish: ["FISH_API_KEY", "ELEVENLABS_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  ghl: ["GHL_API_KEY", "GHL_LOCATION_ID"],
};

/**
 * Default configured-provider loader: presence-only env detection. Reads
 * whether a key exists — never logs or returns its value (spec §21:
 * secrets never in repo or logs).
 */
export function loadConfiguredProviders(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ConfiguredProvider[] {
  const configured: ConfiguredProvider[] = [];
  for (const [provider, keys] of Object.entries(PROVIDER_ENV_KEYS)) {
    const present = keys.some((k) => {
      const v = env[k];
      return typeof v === "string" && v.length > 0;
    });
    configured.push({
      provider,
      credentialsPresent: present,
      configuredModels: [],
    });
  }
  return configured;
}

/** Injected registry loader — returns documented profiles from any store. */
export type RegistryLoader = () => Promise<
  readonly DocumentedCapability[]
> | readonly DocumentedCapability[];

/** Default documented loader: empty (scaffold registry has no profiles yet). */
export const emptyRegistryLoader: RegistryLoader = () => [];

/** Safe probe registry: none registered yet — observation is "skipped". */
export const defaultProbes: Readonly<Record<string, CapabilityProbe>> = {};

/** Options for {@link runProvidersVerify}. */
export interface RunProvidersVerifyOptions extends VerifyOptions {
  /** Configured providers; defaults to env-presence detection. */
  configured?: readonly ConfiguredProvider[];
  /** Documented profiles; defaults to none. */
  registry?: RegistryLoader;
  /** Probes by provider name; defaults to none (skipped observation). */
  probes?: Readonly<Record<string, CapabilityProbe>>;
}

/** Full command result: text + JSON + the underlying structured result. */
export interface ProvidersVerifyCommandResult {
  /** Human-readable multi-line report (stdout payload). */
  text: string;
  /** JSON view for `--json` consumers. */
  json: unknown;
  /** Structured result for tests/programmatic use. */
  result: ProviderVerifyResult;
}

/**
 * Execute the `providers verify` command logic. Pure orchestration — the
 * only I/O lives in the injected loaders/probes.
 */
export async function runProvidersVerify(
  options: RunProvidersVerifyOptions = {},
): Promise<ProvidersVerifyCommandResult> {
  const configured = options.configured ?? loadConfiguredProviders();
  const documented = options.registry
    ? await Promise.resolve(options.registry())
    : [];
  const result = await verifyProviders(
    configured,
    documented,
    options.probes ?? defaultProbes,
    options,
  );
  return {
    text: formatVerifyReport(result),
    json: verifyResultToJson(result),
    result,
  };
}