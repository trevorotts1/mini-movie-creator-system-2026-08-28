/**
 * CAP-009 — Provider health/verify engine, CLI-local copy (CHAR-004 pattern).
 *
 * The canonical engine lives in `packages/capability-registry/src/verify/`
 * (CAP-009 owns both paths). The CLI must NOT import the workspace package:
 * `apps/cli/tsconfig.json` pins `rootDir: src`, so any `@mmcs/...` import
 * makes the CLI typecheck pull package sources outside its rootDir and fail
 * with TS6059. CHAR-004 established the pattern for commands: declare the
 * types locally and keep the command self-contained; the dispatcher merges
 * at integration.
 *
 * Rules encoded (runbook §61):
 *   - Reports configured vs documented vs runtime-observed capability, the
 *     last verified date, and discrepancy warnings.
 *   - A probe that throws/times out/reports failure is recorded TRANSIENT;
 *     it is NOT evidence against the documented capability, adds only a
 *     warning, and sets verificationUsable = false — a transient failure
 *     NEVER silently rewrites VERIFIED capability.
 *   - `applyOverrides` returns NEW registry objects, never mutates input,
 *     never rewrites a fact whose `verifiedFacts` marks it VERIFIED.
 *
 * These types are structurally identical to the package's
 * {@link @mmcs/capability-registry} exports (same names, same shapes), so
 * integration wiring — and the package's own `verifyProviders` — accept
 * these values without conversion. Runtime inputs from registry-backed
 * stores are accepted through `toDocumentedCapability`, which only narrows
 * objects that already satisfy the shape (never guesses).
 *
 * Pure module — no I/O, no fetch, no clock reads except through the
 * injected `now()` (defaults to the real clock; tests inject a fixed one).
 */

/** Confidence tiers — mirrors the CAP-001 schema's confidence values. */
export type VerifyConfidence = "VERIFIED" | "PROVISIONAL" | "UNKNOWN";

/**
 * How an observation was obtained. `probed` = a live safe check ran and
 * answered; `transient` = the probe failed/timed out/errored (one bad
 * observation says nothing about the true capability); `skipped` = no
 * probe was available/safe for this model.
 */
export type ObservationKind = "probed" | "transient" | "skipped";

/**
 * The configured view: what the operator's environment actually has set up
 * for one provider. Shaped loosely — callers map their config format onto
 * this. `null` = unknown/unset, never guessed.
 */
export interface ConfiguredProvider {
  /** Provider name as configured (e.g. "agnes", "kie"). */
  provider: string;
  /** True when the provider's credentials are present in the environment. */
  credentialsPresent: boolean | null;
  /** Model IDs the operator's config currently selects, if any. */
  configuredModels: readonly string[];
}

/**
 * A safe runtime observation of one capability fact. "Safe" means the probe
 * makes no paid generation call and no destructive call (list/models/health
 * style endpoints only).
 */
export interface RuntimeObservation {
  /** Dot-path of the observed fact, e.g. "references.maxImages". */
  field: string;
  /** The observed value; null = the probe could not observe this value. */
  value: unknown;
  /** How this observation was obtained. */
  kind: ObservationKind;
  /** Probe error message when kind === "transient"; safe to log. */
  error?: string;
}

/** Result of one injected probe for one provider/model. */
export type ProbeResult =
  | { ok: true; observations: readonly RuntimeObservation[] }
  | { ok: false; error: string };

/**
 * An injected, side-effect-free probe. Returns a ProbeResult; throwing is
 * also tolerated (converted to a TRANSIENT result) so a probe author can
 * use plain async code.
 */
export type CapabilityProbe = (
  provider: string,
  modelId: string,
) => Promise<ProbeResult>;

/** The documented view: the slice of the CAP-001 profile verify reads. */
export interface DocumentedCapability {
  provider: string;
  modelId: string;
  /** CAP-001 confidence tier of the documented values. */
  confidence: VerifyConfidence;
  /** ISO-8601 timestamp of the last human verification, if recorded. */
  lastVerifiedAt: string | null;
  /** Documented capability facts as dot-path -> value (null = unknown). */
  facts: Readonly<Record<string, unknown>>;
}

/**
 * Narrow a registry-shaped object into a {@link DocumentedCapability}.
 * Returns null when the input does not carry the documented shape — the
 * caller keeps the value out of the verify run rather than inventing one.
 */
export function toDocumentedCapability(input: unknown): DocumentedCapability | null {
  if (typeof input !== "object" || input === null) return null;
  const candidate = input as Record<string, unknown>;
  if (typeof candidate.provider !== "string") return null;
  if (typeof candidate.modelId !== "string") return null;
  const confidence = candidate.confidence;
  if (confidence !== "VERIFIED" && confidence !== "PROVISIONAL" && confidence !== "UNKNOWN") {
    return null;
  }
  const lastVerifiedAt = candidate.lastVerifiedAt;
  if (lastVerifiedAt !== null && lastVerifiedAt !== undefined && typeof lastVerifiedAt !== "string") {
    return null;
  }
  const facts = candidate.facts;
  if (typeof facts !== "object" || facts === null) return null;
  return {
    provider: candidate.provider,
    modelId: candidate.modelId,
    confidence,
    lastVerifiedAt: typeof lastVerifiedAt === "string" ? lastVerifiedAt : null,
    facts: { ...(facts as Record<string, unknown>) },
  };
}

/** Severity of one discrepancy finding. */
export type DiscrepancySeverity = "MISMATCH" | "UNDOCUMENTED" | "STALE";

/** One discrepancy finding between views. */
export interface Discrepancy {
  /** Dot-path of the fact in question. */
  field: string;
  severity: DiscrepancySeverity;
  /** Human-readable warning; safe to log. */
  message: string;
  /** The documented value (when the mismatch is documented-vs-observed). */
  documented?: unknown;
  /** The observed value (when the mismatch is documented-vs-observed). */
  observed?: unknown;
}

/** Per-model verify report (runbook §61 output shape). */
export interface ProviderVerifyReport {
  provider: string;
  modelId: string;
  /** The configured view as given. */
  configured: ConfiguredProvider;
  /** The documented view as given. */
  documented: DocumentedCapability;
  /** Runtime observations (possibly empty when skipped). */
  observed: readonly RuntimeObservation[];
  /** Findings that need human attention; empty = consistent. */
  discrepancies: readonly Discrepancy[];
  /** "OK" when consistent, "DISCREPANCY" when findings exist. */
  status: "OK" | "DISCREPANCY";
  /** ISO-8601 of this verification run (from the injected clock). */
  verifiedAt: string;
  /**
   * Whether this run may update the registry's lastVerifiedAt. False whenever
   * any observation was TRANSIENT or the model has open MISMATCH findings —
   * a transient failure or a live mismatch never refreshes VERIFIED state.
   */
  verificationUsable: boolean;
}

/** Full command result: one report per configured model plus summary. */
export interface ProviderVerifyResult {
  reports: readonly ProviderVerifyReport[];
  /** Models with at least one discrepancy. */
  discrepancyCount: number;
  /** Models where every probe observation was transient (none usable). */
  transientCount: number;
  /** ISO-8601 of the run (from the injected clock). */
  verifiedAt: string;
}

/** Options for {@link verifyProviders}. */
export interface VerifyOptions {
  /** Injected clock (ISO-8601). Defaults to the real current time. */
  now?: () => string;
  /** Probe timeout in ms; a probe exceeding it is recorded TRANSIENT. Default 10_000. */
  timeoutMs?: number;
  /** A documented fact older than this many days is flagged STALE. Default 30. */
  staleDays?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_STALE_DAYS = 30;

/** Minimal timer surface so the module stays DOM-lib-free (Node + tests). */
interface ProbeTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const timers: ProbeTimers = {
  setTimeout(fn, ms) {
    return globalThis.setTimeout(fn, ms);
  },
  clearTimeout(handle) {
    globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>);
  },
};

/** Run one probe under a timeout; convert throw/hang into a TRANSIENT result. */
async function runProbe(
  probe: CapabilityProbe,
  provider: string,
  modelId: string,
  timeoutMs: number,
): Promise<ProbeResult> {
  let timer: unknown;
  let fired = false;
  try {
    const result = await Promise.race([
      Promise.resolve().then(() => probe(provider, modelId)),
      new Promise<ProbeResult>((_, reject) => {
        timer = timers.setTimeout(() => {
          fired = true;
          reject(new Error(`probe timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
    return result;
  } catch (err) {
    // Timeout rejection and probe failure both land here; the message
    // distinguishes them. Either way the observation is TRANSIENT.
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  } finally {
    if (timer !== undefined && !fired) timers.clearTimeout(timer);
  }
}

/** Parse an ISO-8601 date; null when unparseable (never guessed). */
function parseDate(value: string | null): number | null {
  if (value === null) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

/** Shallow structural equality used to compare documented vs observed facts. */
function factsEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "number") return a === b;
  if (typeof a === "boolean" && typeof b === "boolean") return a === b;
  return false;
}

/**
 * Verify configured models against their documented capability and, where a
 * safe probe exists, the runtime-observed reality. Pure: the only external
 * behavior comes from the injected probes and clock.
 *
 * Rules encoded (runbook §61):
 *   - Documented fact vs observed fact differ -> MISMATCH discrepancy + warning.
 *   - Observed fact with no documented counterpart -> UNDOCUMENTED discrepancy.
 *   - Documented lastVerifiedAt older than staleDays -> STALE discrepancy.
 *   - A probe that throws/times out/reports failure is recorded as TRANSIENT;
 *     it is NOT treated as evidence against the documented capability and it
 *     sets verificationUsable = false (a transient failure never silently
 *     rewrites VERIFIED).
 */
export async function verifyProviders(
  configured: readonly ConfiguredProvider[],
  documentedProfiles: readonly DocumentedCapability[],
  probes: Readonly<Record<string, CapabilityProbe>> = {},
  options: VerifyOptions = {},
): Promise<ProviderVerifyResult> {
  const now = options.now ?? (() => new Date().toISOString());
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const staleDays = options.staleDays ?? DEFAULT_STALE_DAYS;
  const verifiedAt = now();
  const staleMs = staleDays * 24 * 60 * 60 * 1000;
  const nowMs = parseDate(verifiedAt) ?? Date.now();

  const documentedByModel = new Map<string, DocumentedCapability>();
  for (const profile of documentedProfiles) {
    documentedByModel.set(`${profile.provider}/${profile.modelId}`, profile);
  }

  const reports: ProviderVerifyReport[] = [];
  for (const cfg of configured) {
    for (const modelId of cfg.configuredModels) {
      const key = `${cfg.provider}/${modelId}`;
      const doc = documentedByModel.get(key);
      const documented: DocumentedCapability = doc ?? {
        provider: cfg.provider,
        modelId,
        confidence: "UNKNOWN",
        lastVerifiedAt: null,
        facts: {},
      };
      const discrepancies: Discrepancy[] = [];
      const observed: RuntimeObservation[] = [];
      let anyTransient = false;

      const probe = probes[cfg.provider];
      if (probe === undefined) {
        observed.push({
          field: "*",
          value: null,
          kind: "skipped",
        });
      } else {
        const result = await runProbe(probe, cfg.provider, modelId, timeoutMs);
        if (!result.ok) {
          anyTransient = true;
          observed.push({
            field: "*",
            value: null,
            kind: "transient",
            error: result.error,
          });
          discrepancies.push({
            field: "*",
            severity: "MISMATCH",
            message: `runtime probe failed transiently for ${key}: ${result.error} — documented capability left unchanged (transient failure never rewrites VERIFIED)`,
          });
        } else {
          for (const observation of result.observations) {
            observed.push(observation);
            if (observation.kind === "transient") {
              anyTransient = true;
              discrepancies.push({
                field: observation.field,
                severity: "MISMATCH",
                message: `runtime probe for ${key} field ${observation.field} failed transiently${observation.error ? `: ${observation.error}` : ""} — documented capability left unchanged`,
              });
              continue;
            }
            if (observation.kind === "skipped") continue;
            if (!(observation.field in documented.facts)) {
              discrepancies.push({
                field: observation.field,
                severity: "UNDOCUMENTED",
                message: `runtime observed ${key} field ${observation.field} has no documented counterpart (documented registry is missing this fact)`,
                observed: observation.value,
              });
              continue;
            }
            const docValue = documented.facts[observation.field];
            if (docValue !== null && !factsEqual(docValue, observation.value)) {
              discrepancies.push({
                field: observation.field,
                severity: "MISMATCH",
                message: `documented ${key} ${observation.field} = ${JSON.stringify(docValue)} but runtime observed ${JSON.stringify(observation.value)}`,
                documented: docValue,
                observed: observation.value,
              });
            }
          }
        }
      }

      // Stale-documented check: a VERIFIED/PROVISIONAL profile whose
      // lastVerifiedAt is older than staleDays (or unparseable/missing on a
      // non-UNKNOWN profile) is flagged STALE.
      if (documented.confidence !== "UNKNOWN") {
        const verifiedMs = parseDate(documented.lastVerifiedAt);
        if (verifiedMs === null) {
          discrepancies.push({
            field: "lastVerifiedAt",
            severity: "STALE",
            message: `${key} is ${documented.confidence} but has no parseable lastVerifiedAt — cannot prove freshness`,
          });
        } else if (nowMs - verifiedMs > staleMs) {
          const ageDays = Math.floor((nowMs - verifiedMs) / (24 * 60 * 60 * 1000));
          discrepancies.push({
            field: "lastVerifiedAt",
            severity: "STALE",
            message: `${key} last verified ${ageDays} day(s) ago (>${staleDays}) — re-verify against current provider docs`,
          });
        }
      }

      const status: ProviderVerifyReport["status"] =
        discrepancies.length > 0 ? "DISCREPANCY" : "OK";
      reports.push({
        provider: cfg.provider,
        modelId,
        configured: cfg,
        documented,
        observed,
        discrepancies,
        status,
        verifiedAt,
        // A run is only usable as a fresh verification when nothing was
        // transient and nothing actually mismatched. STALE/UNDOCUMENTED
        // findings don't block re-verification; transient failures do.
        verificationUsable: !anyTransient,
      });
    }
  }

  const discrepancyCount = reports.filter(
    (r) => r.discrepancies.length > 0,
  ).length;
  const transientCount = reports.filter((r) =>
    r.observed.some((o) => o.kind === "transient"),
  ).length;

  return { reports, discrepancyCount, transientCount, verifiedAt };
}

/**
 * The observed-override record CAP-010 consumes. Produced ONLY from probed
 * (non-transient, non-skipped) observations.
 */
export interface ObservedOverride {
  provider: string;
  modelId: string;
  field: string;
  value: unknown;
  observedAt: string;
}

/**
 * Extract override records from a verify result. Transient and skipped
 * observations are never included — one flaky probe must never look like a
 * capability change (runbook §61).
 */
export function observedOverrides(
  result: ProviderVerifyResult,
): ObservedOverride[] {
  const overrides: ObservedOverride[] = [];
  for (const report of result.reports) {
    for (const observation of report.observed) {
      if (observation.kind !== "probed") continue;
      if (observation.value === null) continue;
      overrides.push({
        provider: report.provider,
        modelId: report.modelId,
        field: observation.field,
        value: observation.value,
        observedAt: report.verifiedAt,
      });
    }
  }
  return overrides;
}

/**
 * The minimal registry slice {@link applyOverrides} operates on. Structural
 * (like CAP-004's ReferenceCountProfile) so it works against any registry
 * object that exposes provider/modelId/facts — including CAP-001 profiles.
 */
export interface OverridableRegistryEntry {
  provider: string;
  modelId: string;
  /** Dot-path -> documented value. */
  facts: Record<string, unknown>;
  /**
   * Per-fact confidence for fields whose value is human-verified. Absent or
   * non-VERIFIED = overridable by a runtime observation; VERIFIED facts are
   * never silently rewritten (runbook §61).
   */
  verifiedFacts?: Readonly<Record<string, true>>;
}

/**
 * Apply observed overrides to registry entries, returning NEW entry objects.
 *
 * Hard rules (runbook §61):
 *   - The input entries are never mutated.
 *   - Overrides only replace facts whose documented value is not VERIFIED —
 *     a VERIFIED documented value is never silently rewritten. Callers who
 *     genuinely intend to supersede a VERIFIED value must do that explicitly
 *     through their own review flow, not through this helper.
 *   - Fields the entry doesn't document become documented as newly observed.
 */
export function applyOverrides(
  entries: readonly OverridableRegistryEntry[],
  overrides: readonly ObservedOverride[],
): OverridableRegistryEntry[] {
  const byKey = new Map<string, OverridableRegistryEntry>();
  for (const entry of entries) {
    byKey.set(`${entry.provider}/${entry.modelId}`, entry);
  }
  for (const override of overrides) {
    const key = `${override.provider}/${override.modelId}`;
    const entry = byKey.get(key);
    if (entry === undefined) continue;
    const nextFacts = { ...entry.facts };
    const nextVerified = entry.verifiedFacts
      ? { ...entry.verifiedFacts }
      : undefined;
    // A VERIFIED documented fact is never silently rewritten by an
    // observation; everything else (PROVISIONAL/UNKNOWN/missing) updates.
    const isVerifiedFact = entry.verifiedFacts?.[override.field] === true;
    if (!isVerifiedFact) {
      nextFacts[override.field] = override.value;
    }
    byKey.set(key, {
      ...entry,
      facts: nextFacts,
      verifiedFacts: nextVerified,
    });
  }
  return [...byKey.values()].map((entry) => ({
    provider: entry.provider,
    modelId: entry.modelId,
    facts: { ...entry.facts },
    verifiedFacts: entry.verifiedFacts
      ? { ...entry.verifiedFacts }
      : undefined,
  }));
}
