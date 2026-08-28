/// <reference types="node" />
/**
 * Final episode QC + production report for MMCS (spec §20-§21, runbook
 * QC-012).
 *
 * Full-episode QC runs BEFORE rough-cut presentation (`presentationGate`),
 * and after the final render it collects the production report: runtime;
 * aspect ratio/resolution; providers/models used; generated/accepted/rejected
 * seconds; retries; cost; quota usage; characters; canon changes; durable
 * final URL; QC status (spec §21).
 *
 * Per-shot visual QC (identity/wardrobe/continuity/routes) happens earlier;
 * this module aggregates those per-shot results into one episode verdict and
 * enforces report integrity. In particular a 720p generated source upscaled
 * to 1080p is never represented as native 1080p quality (spec §21) — the
 * report carries an explicit `nativeQuality`/`upscaledSegments` provenance
 * instead of a silent resolution claim.
 *
 * Self-contained by design: no package imports, no DB, no network, no
 * dependency on the per-shot QC modules (they land on their own branches).
 * Story/script text is data here, never code — nothing is executed.
 */

export const SHOT_QC_STATUSES = ["accepted", "rejected", "pending"] as const;
export type ShotQcStatus = (typeof SHOT_QC_STATUSES)[number];

export const EPISODE_QC_STATUSES = ["PASS", "FAIL"] as const;
export type EpisodeQcStatus = (typeof EPISODE_QC_STATUSES)[number];

export const ISSUE_SEVERITIES = ["error", "warning"] as const;
export type IssueSeverity = (typeof ISSUE_SEVERITIES)[number];

export interface QcIssue {
  severity: IssueSeverity;
  /** Stable machine-readable code, e.g. "RUNTIME_MISMATCH". */
  code: string;
  message: string;
  /** Shot the issue belongs to, when one does. */
  shotId?: string;
}

export const CANON_CHANGE_STATUSES = ["proposed", "approved", "rejected"] as const;
export type CanonChangeStatus = (typeof CANON_CHANGE_STATUSES)[number];

export interface CanonChange {
  id: string;
  description: string;
  status: CanonChangeStatus;
}

export interface Resolution {
  width: number;
  height: number;
}

/** Tolerances applied by the episode QC (exported for tests/inspection). */
export const EPISODE_QC_TOLERANCES = {
  /** |sum(shot durations) − rendered runtime| beyond this is an integrity error. */
  runtimeReconcileSeconds: 1.0,
  /** |acceptedSeconds − assembly durationSeconds| beyond this warns. */
  acceptedMatchSeconds: 0.5,
  /** Relative deviation from target runtime beyond this warns. */
  targetRuntimeDeviation: 0.15,
  /** |derived aspect ratio − declared aspect ratio| beyond this is an error. */
  aspectRatio: 0.02,
} as const;

/**
 * One shot's production record for the final episode. All seconds are
 * duration seconds; accepted+rejected must not exceed generated.
 */
export interface ShotProductionRecord {
  shotId: string;
  sceneId: string | null;
  /** Generation provider, e.g. "agnes", "kie". */
  provider: string;
  /** Provider model id, e.g. "video-2.5-flash", "seedance-2-mini". */
  model: string;
  /** Accepted clip seconds present in the final assembly (0 for rejected shots). */
  durationSeconds: number;
  /** Total seconds generated across all attempts for this shot. */
  generatedSeconds: number;
  /** Accepted seconds (pre-trim; may exceed the assembly duration). */
  acceptedSeconds: number;
  /** Rejected seconds (was generated, failed QC, discarded). */
  rejectedSeconds: number;
  retries: number;
  /** Cost in `currency`; null = unknown, never invented. */
  cost: number | null;
  currency: string;
  /** Quota consumed; null = not tracked/unknown. */
  quotaUsed: number | null;
  /** Unit of `quotaUsed`, e.g. "frames", "seconds", "tokens". */
  quotaUnit: string | null;
  qcStatus: ShotQcStatus;
  /** Native pre-render source resolution; null = unknown. */
  sourceResolution: Resolution | null;
  /** Character IDs referenced by the shot. */
  characters: string[];
}

export interface FinalEpisodeQcInput {
  episodeId: string;
  seriesId: string;
  name: string | null;
  /** Measured runtime of the rendered final episode, seconds. */
  runtimeSeconds: number;
  /** Target runtime; null = no target declared. */
  targetRuntimeSeconds: number | null;
  /** Declared master aspect ratio: "16:9", "9:16", or "W:H". */
  declaredAspectRatio: string;
  /** Resolution of the rendered final episode. */
  renderResolution: Resolution;
  /** Every shot record of the episode (at least one). */
  shots: ShotProductionRecord[];
  /** Proposed/approved/rejected canon changes collected for the episode. */
  canonChanges: CanonChange[];
  /** Durable canonical URL (GHL MediaStore) of the archived final; null = not archived yet. */
  finalUrl: string | null;
  /** ISO-8601 timestamp full-episode QC completed; null = not yet completed. */
  qcCompletedAt: string | null;
  /** ISO-8601 timestamp the rough cut was presented for approval; null = never presented. */
  presentedAt: string | null;
}

export interface ProviderModelSummary {
  provider: string;
  model: string;
  /** Seconds of accepted clips in the final assembly. */
  playedSeconds: number;
  generatedSeconds: number;
  acceptedSeconds: number;
  rejectedSeconds: number;
  retries: number;
  /** Sum of known per-shot costs; null = no cost recorded. */
  cost: number | null;
  /** Currency of `cost`; null = unknown, never invented. */
  currency: string | null;
}

export interface QuotaUsageSummary {
  provider: string;
  model: string;
  quotaUsed: number;
  unit: string;
}

export interface ProductionReport {
  episodeId: string;
  seriesId: string;
  name: string | null;
  runtimeSeconds: number;
  targetRuntimeSeconds: number | null;
  /** Declared master aspect ratio as configured. */
  aspectRatio: string;
  /** Aspect ratio derived from the rendered resolution (width/height). */
  renderedAspectRatio: number;
  resolution: Resolution;
  /**
   * True only when every segment was rendered at or above its native source
   * resolution. False when any generated source was upscaled — the episode is
   * then never represented as native render-resolution quality.
   */
  nativeQuality: boolean;
  /** Number of segments whose native source was upscaled to the render size. */
  upscaledSegments: number;
  providersModels: ProviderModelSummary[];
  generatedSeconds: number;
  acceptedSeconds: number;
  rejectedSeconds: number;
  retries: number;
  /** Sum of known shot costs; null when no shot recorded a cost. */
  costTotal: number | null;
  /** Currency of `costTotal`; null when no cost was recorded. */
  currency: string | null;
  quotaUsage: QuotaUsageSummary[];
  /** Unique character IDs, sorted. */
  characters: string[];
  characterCount: number;
  canonChanges: CanonChange[];
  finalUrl: string | null;
  qcStatus: EpisodeQcStatus;
}

export interface PresentationGate {
  allowed: boolean;
  reason: string;
}

export interface FinalEpisodeQcResult {
  status: EpisodeQcStatus;
  issues: QcIssue[];
  report: ProductionReport;
  presentationAllowed: boolean;
  presentationGateReason: string;
}

const ASPECT_PATTERN = /^(\d+):(\d+)$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const ISO_DATETIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

/**
 * Composite key separator for provider/model grouping. Unit separator
 * (U+0001) — no printable text can appear inside a provider or model id, so
 * "agnes\u0001video-2.5" can never collide with "agnes2\u0001video-2.5".
 */
const COMPOSITE_KEY_SEPARATOR = String.fromCharCode(1);

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isHttpUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:";
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function isValidCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12) {
    return false;
  }
  const maxDay = month === 2 && isLeapYear(year) ? 29 : DAYS_IN_MONTH[month - 1] ?? 31;
  return day >= 1 && day <= maxDay;
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const match = ISO_DATETIME_PATTERN.exec(value);
  if (match === null) {
    return false;
  }
  // Date.parse overflows invalid calendar dates (2026-02-31 → Mar 3), so
  // validate the calendar explicitly — a report timestamp must be real.
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (!isValidCalendarDate(year, month, day)) {
    return false;
  }
  if (hour > 23 || minute > 59 || second > 59) {
    return false;
  }
  return !Number.isNaN(Date.parse(value));
}

function assertString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`final-episode QC input: ${field} must be a non-empty string`);
  }
}

/**
 * Parse "W:H" into a numeric aspect ratio (16:9 → 1.777…). Throws TypeError
 * on malformed input — a declared aspect ratio is configuration, so bad
 * config must fail loudly rather than silently pass.
 */
export function parseAspectRatio(text: string): number {
  const match = ASPECT_PATTERN.exec(text);
  if (match === null) {
    throw new TypeError(`Invalid aspect ratio "${text}" — expected "W:H" (e.g. "16:9").`);
  }
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width <= 0 || height <= 0) {
    throw new TypeError(`Invalid aspect ratio "${text}" — both sides must be positive integers.`);
  }
  return width / height;
}

/**
 * Validate the QC input shape. Throws TypeError naming the first invalid
 * field — never coerces or guesses, so a report cannot silently contain
 * invented data.
 */
export function validateFinalEpisodeQcInput(input: FinalEpisodeQcInput): void {
  assertString(input?.episodeId, "episodeId");
  assertString(input.seriesId, "seriesId");
  if (input.name !== null && typeof input.name !== "string") {
    throw new TypeError("final-episode QC input: name must be a string or null");
  }
  if (!isNonNegativeNumber(input.runtimeSeconds) || input.runtimeSeconds <= 0) {
    throw new TypeError("final-episode QC input: runtimeSeconds must be a positive number");
  }
  if (
    input.targetRuntimeSeconds !== null &&
    !isNonNegativeNumber(input.targetRuntimeSeconds)
  ) {
    throw new TypeError("final-episode QC input: targetRuntimeSeconds must be a non-negative number or null");
  }
  parseAspectRatio(input.declaredAspectRatio); // throws on malformed
  const res = input.renderResolution;
  if (res === undefined || !isNonNegativeInteger(res.width) || res.width <= 0 || !isNonNegativeInteger(res.height) || res.height <= 0) {
    throw new TypeError("final-episode QC input: renderResolution must have positive integer width/height");
  }
  if (!Array.isArray(input.shots) || input.shots.length === 0) {
    throw new TypeError("final-episode QC input: shots must be a non-empty array");
  }
  for (const shot of input.shots) {
    validateShotRecord(shot);
  }
  if (!Array.isArray(input.canonChanges)) {
    throw new TypeError("final-episode QC input: canonChanges must be an array");
  }
  for (const change of input.canonChanges) {
    assertString(change?.id, "canonChange.id");
    assertString(change.description, "canonChange.description");
    if (!CANON_CHANGE_STATUSES.includes(change.status)) {
      throw new TypeError(`final-episode QC input: canonChange.status must be one of ${CANON_CHANGE_STATUSES.join("/")}`);
    }
  }
  if (input.finalUrl !== null) {
    assertString(input.finalUrl, "finalUrl");
    if (!isHttpUrl(input.finalUrl)) {
      throw new TypeError(`final-episode QC input: finalUrl must be an http(s) URL (got "${input.finalUrl}")`);
    }
  }
  if (input.qcCompletedAt !== null && !isIsoTimestamp(input.qcCompletedAt)) {
    throw new TypeError("final-episode QC input: qcCompletedAt must be an ISO-8601 timestamp or null");
  }
  if (input.presentedAt !== null && !isIsoTimestamp(input.presentedAt)) {
    throw new TypeError("final-episode QC input: presentedAt must be an ISO-8601 timestamp or null");
  }
}

function validateShotRecord(shot: ShotProductionRecord): void {
  assertString(shot?.shotId, "shot.shotId");
  if (shot.sceneId !== null && (typeof shot.sceneId !== "string" || shot.sceneId.trim().length === 0)) {
    throw new TypeError("final-episode QC input: shot.sceneId must be a non-empty string or null");
  }
  assertString(shot.provider, `shot ${shot.shotId} provider`);
  assertString(shot.model, `shot ${shot.shotId} model`);
  if (!isNonNegativeNumber(shot.durationSeconds)) {
    throw new TypeError(`final-episode QC input: shot ${shot.shotId} durationSeconds must be a non-negative number`);
  }
  // An accepted shot must contribute assembly seconds; a rejected/pending
  // shot legitimately has no clip in the final assembly (duration 0).
  if (shot.qcStatus === "accepted" && shot.durationSeconds <= 0) {
    throw new TypeError(`final-episode QC input: accepted shot ${shot.shotId} durationSeconds must be a positive number`);
  }
  // A shot that never made the assembly must not claim accepted seconds:
  // accepted seconds means "generated seconds that passed QC and were
  // accepted for assembly". A rejected shot contributes none.
  if (shot.qcStatus !== "accepted" && shot.acceptedSeconds > 0) {
    throw new TypeError(`final-episode QC input: shot ${shot.shotId} has acceptedSeconds > 0 but qcStatus is "${shot.qcStatus}" — accepted seconds require an accepted shot`);
  }
  if (!isNonNegativeNumber(shot.generatedSeconds)) {
    throw new TypeError(`final-episode QC input: shot ${shot.shotId} generatedSeconds must be a non-negative number`);
  }
  if (!isNonNegativeNumber(shot.acceptedSeconds)) {
    throw new TypeError(`final-episode QC input: shot ${shot.shotId} acceptedSeconds must be a non-negative number`);
  }
  if (!isNonNegativeNumber(shot.rejectedSeconds)) {
    throw new TypeError(`final-episode QC input: shot ${shot.shotId} rejectedSeconds must be a non-negative number`);
  }
  if (!isNonNegativeInteger(shot.retries)) {
    throw new TypeError(`final-episode QC input: shot ${shot.shotId} retries must be a non-negative integer`);
  }
  if (shot.cost !== null && !isNonNegativeNumber(shot.cost)) {
    throw new TypeError(`final-episode QC input: shot ${shot.shotId} cost must be a non-negative number or null`);
  }
  if (!CURRENCY_PATTERN.test(shot.currency)) {
    throw new TypeError(`final-episode QC input: shot ${shot.shotId} currency must be a 3-letter code (e.g. "USD")`);
  }
  if (shot.quotaUsed !== null && !isNonNegativeNumber(shot.quotaUsed)) {
    throw new TypeError(`final-episode QC input: shot ${shot.shotId} quotaUsed must be a non-negative number or null`);
  }
  if (shot.quotaUnit !== null && typeof shot.quotaUnit !== "string") {
    throw new TypeError(`final-episode QC input: shot ${shot.shotId} quotaUnit must be a string or null`);
  }
  if (!SHOT_QC_STATUSES.includes(shot.qcStatus)) {
    throw new TypeError(`final-episode QC input: shot ${shot.shotId} qcStatus must be one of ${SHOT_QC_STATUSES.join("/")}`);
  }
  if (shot.sourceResolution !== null) {
    const src = shot.sourceResolution;
    if (!isNonNegativeInteger(src.width) || src.width <= 0 || !isNonNegativeInteger(src.height) || src.height <= 0) {
      throw new TypeError(`final-episode QC input: shot ${shot.shotId} sourceResolution must have positive integer width/height or be null`);
    }
  }
  if (!Array.isArray(shot.characters)) {
    throw new TypeError(`final-episode QC input: shot ${shot.shotId} characters must be an array of strings`);
  }
  for (const character of shot.characters) {
    assertString(character, `shot ${shot.shotId} characters[]`);
  }
}

/**
 * Presentation gate (spec §20: "Final episode QC runs before rough-cut
 * presentation"). Presentation is allowed only when full-episode QC
 * completed at or before the presentation time; presenting after an approval
 * event with no QC completion is a hard violation.
 */
export function evaluatePresentationGate(
  qcCompletedAt: string | null,
  presentedAt: string | null,
): PresentationGate {
  if (presentedAt === null) {
    return { allowed: true, reason: "No rough-cut presentation recorded." };
  }
  if (qcCompletedAt === null) {
    return {
      allowed: false,
      reason: "Rough cut presented before full-episode QC completed.",
    };
  }
  const qcTime = Date.parse(qcCompletedAt);
  const presentedTime = Date.parse(presentedAt);
  if (Number.isNaN(qcTime) || Number.isNaN(presentedTime)) {
    return { allowed: false, reason: "Invalid QC/presentation timestamps." };
  }
  if (qcTime > presentedTime) {
    return {
      allowed: false,
      reason: "Rough cut presented before full-episode QC completed.",
    };
  }
  return { allowed: true, reason: "Full-episode QC completed before presentation." };
}

function issue(severity: IssueSeverity, code: string, message: string, shotId?: string): QcIssue {
  return shotId === undefined ? { severity, code, message } : { severity, code, message, shotId };
}

interface Aggregate {
  playedSeconds: number;
  generatedSeconds: number;
  acceptedSeconds: number;
  rejectedSeconds: number;
  retries: number;
  /** Cost summed from shots of this provider/model (single currency per shot). */
  cost: number | null;
  /** Set of shot currencies summed into `cost`; >1 entries = mixed and untrustworthy. */
  costCurrencies: Set<string>;
}

/** Aggregate per-shot records into the §21 production report, pushing issues. */
export function buildProductionReport(
  input: FinalEpisodeQcInput,
  issues: QcIssue[] = [],
): ProductionReport {
  const byProviderModel = new Map<string, Aggregate & { provider: string; model: string }>();
  const quotaByProviderModel = new Map<string, QuotaUsageSummary>();
  const characters = new Set<string>();
  const costEntries: Array<{ cost: number; currency: string }> = [];
  const upscaledShotIds: string[] = [];
  let generatedSeconds = 0;
  let acceptedSeconds = 0;
  let rejectedSeconds = 0;
  let retries = 0;
  let assemblySeconds = 0;

  for (const shot of input.shots) {
    generatedSeconds += shot.generatedSeconds;
    acceptedSeconds += shot.acceptedSeconds;
    rejectedSeconds += shot.rejectedSeconds;
    retries += shot.retries;

    const key = `${shot.provider}${COMPOSITE_KEY_SEPARATOR}${shot.model}`;
    let entry = byProviderModel.get(key);
    if (entry === undefined) {
      entry = {
        provider: shot.provider,
        model: shot.model,
        playedSeconds: 0,
        generatedSeconds: 0,
        acceptedSeconds: 0,
        rejectedSeconds: 0,
        retries: 0,
        cost: null,
        costCurrencies: new Set<string>(),
      };
      byProviderModel.set(key, entry);
    }
    entry.generatedSeconds += shot.generatedSeconds;
    entry.acceptedSeconds += shot.acceptedSeconds;
    entry.rejectedSeconds += shot.rejectedSeconds;
    entry.retries += shot.retries;
    if (shot.cost !== null) {
      entry.cost = (entry.cost ?? 0) + shot.cost;
      entry.costCurrencies.add(shot.currency);
      costEntries.push({ cost: shot.cost, currency: shot.currency });
    }

    if (shot.quotaUsed !== null) {
      const quotaKey = `${shot.provider}${COMPOSITE_KEY_SEPARATOR}${shot.model}`;
      const existing = quotaByProviderModel.get(quotaKey);
      const unit = shot.quotaUnit ?? "count";
      if (existing === undefined) {
        quotaByProviderModel.set(quotaKey, { provider: shot.provider, model: shot.model, quotaUsed: shot.quotaUsed, unit });
      } else {
        if (existing.unit !== unit) {
          issues.push(
            issue(
              "warning",
              "QUOTA_UNIT_MISMATCH",
              `Quota unit mismatch for ${shot.provider}/${shot.model}: "${existing.unit}" vs "${unit}".`,
            ),
          );
        }
        existing.quotaUsed += shot.quotaUsed;
      }
    }

    for (const character of shot.characters) {
      characters.add(character);
    }

    // QC status per shot: only accepted shots may appear in a final episode.
    if (shot.qcStatus === "pending") {
      issues.push(
        issue("error", "SHOT_NOT_ACCEPTED", `Shot ${shot.shotId} is still pending QC — cannot assemble a final episode.`, shot.shotId),
      );
    } else if (shot.qcStatus === "rejected") {
      issues.push(
        issue("error", "SHOT_NOT_ACCEPTED", `Shot ${shot.shotId} was rejected — regenerate before final assembly.`, shot.shotId),
      );
    } else {
      assemblySeconds += shot.durationSeconds;
      entry.playedSeconds += shot.durationSeconds;
      if (Math.abs(shot.acceptedSeconds - shot.durationSeconds) > EPISODE_QC_TOLERANCES.acceptedMatchSeconds) {
        issues.push(
          issue(
            "warning",
            "ACCEPTED_MATCH",
            `Shot ${shot.shotId}: acceptedSeconds (${shot.acceptedSeconds}) differs from assembly duration (${shot.durationSeconds}) — clip was trimmed.`,
            shot.shotId,
          ),
        );
      }
    }

    if (
      shot.acceptedSeconds + shot.rejectedSeconds >
      shot.generatedSeconds + EPISODE_QC_TOLERANCES.acceptedMatchSeconds
    ) {
      issues.push(
        issue(
          "error",
          "SECONDS_CONSISTENCY",
          `Shot ${shot.shotId}: accepted+rejected (${shot.acceptedSeconds + shot.rejectedSeconds}) exceeds generated (${shot.generatedSeconds}).`,
          shot.shotId,
        ),
      );
    }

    // Upscale provenance: never represent an upscaled segment as native.
    // Only accepted shots live in the final assembly, so only they can make
    // the episode non-native.
    if (
      shot.qcStatus === "accepted" &&
      shot.sourceResolution !== null &&
      (shot.sourceResolution.width < input.renderResolution.width ||
        shot.sourceResolution.height < input.renderResolution.height)
    ) {
      upscaledShotIds.push(shot.shotId);
      issues.push(
        issue(
          "warning",
          "UPSCALED",
          `Shot ${shot.shotId}: native source ${shot.sourceResolution.width}x${shot.sourceResolution.height} upscaled to render ${input.renderResolution.width}x${input.renderResolution.height} — report marks the episode as non-native quality.`,
          shot.shotId,
        ),
      );
    }
  }

  // Integrity: rendered runtime must reconcile with the assembled shots.
  if (Math.abs(assemblySeconds - input.runtimeSeconds) > EPISODE_QC_TOLERANCES.runtimeReconcileSeconds) {
    issues.push(
      issue(
        "error",
        "RUNTIME_MISMATCH",
        `Rendered runtime ${input.runtimeSeconds}s does not reconcile with assembled shot durations ${assemblySeconds}s.`,
      ),
    );
  }

  if (input.targetRuntimeSeconds !== null && input.targetRuntimeSeconds > 0) {
    const deviation = Math.abs(input.runtimeSeconds - input.targetRuntimeSeconds) / input.targetRuntimeSeconds;
    if (deviation > EPISODE_QC_TOLERANCES.targetRuntimeDeviation) {
      issues.push(
        issue(
          "warning",
          "TARGET_DEVIATION",
          `Runtime ${input.runtimeSeconds}s deviates ${(deviation * 100).toFixed(1)}% from target ${input.targetRuntimeSeconds}s.`,
        ),
      );
    }
  }

  // Aspect: derived render ratio must match the declared master format.
  const declaredRatio = parseAspectRatio(input.declaredAspectRatio);
  const renderedRatio = input.renderResolution.width / input.renderResolution.height;
  if (Math.abs(declaredRatio - renderedRatio) > EPISODE_QC_TOLERANCES.aspectRatio) {
    issues.push(
      issue(
        "error",
        "ASPECT_MISMATCH",
        `Rendered resolution ${input.renderResolution.width}x${input.renderResolution.height} (${renderedRatio.toFixed(3)}) does not match declared aspect ratio ${input.declaredAspectRatio} (${declaredRatio.toFixed(3)}).`,
      ),
    );
  }

  // Currency consistency: a report cannot sum mixed-currency costs.
  const currencies = new Set(costEntries.map((entry) => entry.currency));
  let costTotal: number | null = null;
  let reportCurrency: string | null = null;
  if (costEntries.length > 0) {
    if (currencies.size > 1) {
      issues.push(
        issue(
          "error",
          "CURRENCY_MISMATCH",
          `Shot costs span multiple currencies (${[...currencies].join(", ")}) — cannot compute a single cost total.`,
        ),
      );
    } else {
      costTotal = costEntries.reduce((sum, entry) => sum + entry.cost, 0);
      reportCurrency = costEntries[0]?.currency ?? null;
    }
    if (costEntries.length < input.shots.length) {
      issues.push(
        issue(
          "warning",
          "PARTIAL_COST_COVERAGE",
          `Cost recorded for ${costEntries.length}/${input.shots.length} shots — total may understate actual spend.`,
        ),
      );
    }
  }

  if (input.finalUrl === null) {
    issues.push(
      issue("error", "MISSING_FINAL_URL", "No durable final URL recorded — the final episode is not archived."),
    );
  }

  const gate = evaluatePresentationGate(input.qcCompletedAt, input.presentedAt);
  if (!gate.allowed) {
    issues.push(issue("error", "PRESENTATION_BEFORE_QC", gate.reason));
  }

  const providersModels: ProviderModelSummary[] = [...byProviderModel.values()].map((entry) => ({
    provider: entry.provider,
    model: entry.model,
    playedSeconds: entry.playedSeconds,
    generatedSeconds: entry.generatedSeconds,
    acceptedSeconds: entry.acceptedSeconds,
    rejectedSeconds: entry.rejectedSeconds,
    retries: entry.retries,
    // Per-model cost is only trustworthy when every summed shot shares one
    // currency; mixed-currency sums are garbage, so null them out instead of
    // inventing a number.
    cost: entry.cost !== null && entry.costCurrencies.size <= 1 ? entry.cost : null,
    currency: entry.cost !== null && entry.costCurrencies.size === 1 ? [...entry.costCurrencies][0] ?? null : null,
  }));

  const sortedCharacters = [...characters].sort();

  return {
    episodeId: input.episodeId,
    seriesId: input.seriesId,
    name: input.name,
    runtimeSeconds: input.runtimeSeconds,
    targetRuntimeSeconds: input.targetRuntimeSeconds,
    aspectRatio: input.declaredAspectRatio,
    renderedAspectRatio: renderedRatio,
    resolution: { ...input.renderResolution },
    nativeQuality: upscaledShotIds.length === 0,
    upscaledSegments: upscaledShotIds.length,
    providersModels,
    generatedSeconds,
    acceptedSeconds,
    rejectedSeconds,
    retries,
    costTotal,
    currency: reportCurrency,
    quotaUsage: [...quotaByProviderModel.values()],
    characters: sortedCharacters,
    characterCount: sortedCharacters.length,
    canonChanges: input.canonChanges.map((change) => ({ ...change })),
    finalUrl: input.finalUrl,
    // The report must never claim PASS while error-severity issues were
    // collected into it — a lying report is worse than no report.
    qcStatus: issues.some((item) => item.severity === "error") ? "FAIL" : "PASS",
  };
}

/**
 * Run full-episode QC on a finished episode. Status is PASS only when no
 * error-severity issue exists (warnings — target deviation, accepted-match
 * trim, upscale provenance, partial cost coverage — never fail the episode).
 */
export function runFinalEpisodeQC(input: FinalEpisodeQcInput): FinalEpisodeQcResult {
  validateFinalEpisodeQcInput(input);
  const issues: QcIssue[] = [];
  const report = buildProductionReport(input, issues);
  const gate = evaluatePresentationGate(input.qcCompletedAt, input.presentedAt);
  const status: EpisodeQcStatus = issues.some((item) => item.severity === "error") ? "FAIL" : "PASS";
  return {
    status,
    issues,
    report: { ...report, qcStatus: status },
    presentationAllowed: gate.allowed,
    presentationGateReason: gate.reason,
  };
}
