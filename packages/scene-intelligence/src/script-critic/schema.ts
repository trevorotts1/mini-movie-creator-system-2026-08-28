/**
 * Script critic findings schema — DIR-006 (runbook §24, spec.md §14).
 *
 * The script critic reviews an approved-draft screenplay and returns
 * STRUCTURED findings in exactly four categories (runbook: pacing,
 * continuity, dialogue, character consistency). Findings feed DIR-007's
 * revision loop (findings → targeted revision → re-criticize) and DIR-008's
 * gate-2 approval decision, so the shape is a versioned machine contract:
 * `schemaVersion` gates structural changes; consumers pin on the exported
 * constant and `parseCritique` rejects anything newer (same policy as the
 * core checkpoint schema).
 *
 * Screenplay/text content is UNTRUSTED data: it is analyzed and echoed, never
 * executed (no eval, no template interpolation into code paths).
 */

export const SCRIPT_CRITIC_SCHEMA_VERSION = 1 as const;

/** The four finding categories the runbook mandates, in report order. */
export const CRITIC_CATEGORIES = [
  "pacing",
  "continuity",
  "dialogue",
  "character-consistency",
] as const;
export type CriticCategory = (typeof CRITIC_CATEGORIES)[number];

/** Severity ladder, ascending. */
export const CRITIC_SEVERITIES = ["info", "minor", "major", "critical"] as const;
export type CriticSeverity = (typeof CRITIC_SEVERITIES)[number];

/** Critic verdict: clean enough for gate 2, or send back for revision. */
export const CRITIC_VERDICTS = ["pass", "revise"] as const;
export type CriticVerdict = (typeof CRITIC_SEVERITIES)[number] extends never
  ? never
  : "pass" | "revise";

export const CRITIC_SEVERITY_RANK: Readonly<Record<CriticSeverity, number>> = {
  info: 0,
  minor: 1,
  major: 2,
  critical: 3,
};

/** Where a finding anchors. Every field is nullable — global findings exist. */
export interface FindingLocation {
  /** Screenplay scene number (1-based), when the finding is scene-scoped. */
  sceneIndex: number | null;
  /** 1-based position within the scene's dialogue list, when applicable. */
  line: number | null;
  /** Character name the finding concerns, when applicable. */
  character: string | null;
}

/** One structured critic finding. */
export interface ScriptFinding {
  /** Stable id, unique within a critique: `<CATEGORY-CODE>-<n>`. */
  id: string;
  /** Internal rule that produced the finding (e.g. "PAC-static"). */
  rule: string;
  category: CriticCategory;
  severity: CriticSeverity;
  title: string;
  detail: string;
  /** Actionable fix direction; null when the critic has none. */
  suggestion: string | null;
  location: FindingLocation;
}

/** Per-category finding counts, always complete. */
export type CriticCounts = Readonly<Record<CriticCategory, number>>;

/** The versioned critique document a critic model returns. */
export interface ScriptCritique {
  schemaVersion: typeof SCRIPT_CRITIC_SCHEMA_VERSION;
  /** Matches the reviewed screenplay's id. */
  screenplayId: string;
  /** id of the critic model that produced this critique. */
  criticModelId: string;
  /** ISO-8601 UTC creation timestamp. */
  createdAt: string;
  verdict: CriticVerdict;
  findings: ScriptFinding[];
  counts: CriticCounts;
}

export class CriticSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CriticSchemaError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  throw new CriticSchemaError(message);
}

function requiredString(obj: Record<string, unknown>, key: string, path: string): string {
  const value = obj[key];
  if (typeof value !== "string" || value.trim() === "") {
    fail(`${path}.${key} must be a non-empty string, got ${JSON.stringify(value)}`);
  }
  return value;
}

function nullableString(obj: Record<string, unknown>, key: string, path: string): string | null {
  const value = obj[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    fail(`${path}.${key} must be a string or null, got ${JSON.stringify(value)}`);
  }
  return value;
}

function nullablePositiveInt(
  obj: Record<string, unknown>,
  key: string,
  path: string,
): number | null {
  const value = obj[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    fail(
      `${path}.${key} must be a positive integer or null, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/** Verdict implied by findings under a revise threshold. */
export function verdictFromFindings(
  findings: readonly ScriptFinding[],
  reviseOnSeverity: CriticSeverity,
): CriticVerdict {
  const threshold = CRITIC_SEVERITY_RANK[reviseOnSeverity];
  return findings.some((f) => CRITIC_SEVERITY_RANK[f.severity] >= threshold)
    ? "revise"
    : "pass";
}

/** Complete per-category counts from a findings list. */
export function countsFromFindings(findings: readonly ScriptFinding[]): CriticCounts {
  const counts: Record<CriticCategory, number> = {
    pacing: 0,
    continuity: 0,
    dialogue: 0,
    "character-consistency": 0,
  };
  for (const f of findings) {
    if (!(f.category in counts)) {
      fail(`finding ${f.id} has unknown category ${JSON.stringify(f.category)}`);
    }
    counts[f.category] += 1;
  }
  return counts;
}

export interface AssembleCritiqueInput {
  screenplayId: string;
  criticModelId: string;
  createdAt: string;
  findings: readonly ScriptFinding[];
  reviseOnSeverity: CriticSeverity;
}

/** Build the versioned critique envelope around a validated findings list. */
export function assembleCritique(input: AssembleCritiqueInput): ScriptCritique {
  return {
    schemaVersion: SCRIPT_CRITIC_SCHEMA_VERSION,
    screenplayId: input.screenplayId,
    criticModelId: input.criticModelId,
    createdAt: input.createdAt,
    verdict: verdictFromFindings(input.findings, input.reviseOnSeverity),
    findings: [...input.findings],
    counts: countsFromFindings(input.findings),
  };
}

export interface ParseCritiqueOptions {
  /** When set, the critique's screenplayId must match or parsing fails. */
  expectedScreenplayId?: string;
  /** Severity at or above which the verdict must be "revise". Default "major". */
  reviseOnSeverity?: CriticSeverity;
}

/**
 * Strictly validate an untrusted critique object (e.g. a model's JSON output)
 * against schema version 1. Throws CriticSchemaError on any structural
 * mismatch, including: newer/older schemaVersion, unknown category/severity,
 * duplicate finding ids, counts inconsistent with findings, or a verdict
 * inconsistent with the severity threshold.
 */
export function parseCritique(raw: unknown, options: ParseCritiqueOptions = {}): ScriptCritique {
  if (!isRecord(raw)) {
    fail(`critique must be a JSON object, got ${raw === null ? "null" : typeof raw}`);
  }
  const version = raw["schemaVersion"];
  if (typeof version !== "number" || !Number.isInteger(version)) {
    fail(`critique "schemaVersion" must be an integer, got ${JSON.stringify(version)}`);
  }
  if (version > SCRIPT_CRITIC_SCHEMA_VERSION) {
    fail(
      `critique schemaVersion ${version} is newer than supported ${SCRIPT_CRITIC_SCHEMA_VERSION}`,
    );
  }
  if (version !== SCRIPT_CRITIC_SCHEMA_VERSION) {
    fail(`critique schemaVersion ${version} is not supported (expected 1)`);
  }

  const screenplayId = requiredString(raw, "screenplayId", "critique");
  const criticModelId = requiredString(raw, "criticModelId", "critique");
  const createdAt = requiredString(raw, "createdAt", "critique");

  if (options.expectedScreenplayId !== undefined && screenplayId !== options.expectedScreenplayId) {
    fail(
      `critique screenplayId ${JSON.stringify(screenplayId)} does not match expected ${JSON.stringify(options.expectedScreenplayId)}`,
    );
  }

  const rawVerdict = raw["verdict"];
  if (
    typeof rawVerdict !== "string" ||
    !(CRITIC_VERDICTS as readonly string[]).includes(rawVerdict)
  ) {
    fail(`critique "verdict" must be one of ${CRITIC_VERDICTS.join("|")}, got ${JSON.stringify(rawVerdict)}`);
  }

  const rawFindings = raw["findings"];
  if (!Array.isArray(rawFindings)) {
    fail('critique "findings" must be an array');
  }

  const reviseOnSeverity = options.reviseOnSeverity ?? "major";
  const seenIds = new Set<string>();
  const findings: ScriptFinding[] = rawFindings.map((entry, i) => {
    const path = `findings[${i}]`;
    if (!isRecord(entry)) {
      fail(`${path} must be an object`);
    }
    const id = requiredString(entry, "id", path);
    if (seenIds.has(id)) {
      fail(`${path} id ${JSON.stringify(id)} is duplicated`);
    }
    seenIds.add(id);

    const category = entry["category"];
    if (
      typeof category !== "string" ||
      !(CRITIC_CATEGORIES as readonly string[]).includes(category)
    ) {
      fail(
        `${path} "category" must be one of ${CRITIC_CATEGORIES.join("|")}, got ${JSON.stringify(category)}`,
      );
    }
    const severity = entry["severity"];
    if (
      typeof severity !== "string" ||
      !(CRITIC_SEVERITIES as readonly string[]).includes(severity)
    ) {
      fail(
        `${path} "severity" must be one of ${CRITIC_SEVERITIES.join("|")}, got ${JSON.stringify(severity)}`,
      );
    }
    const rule = requiredString(entry, "rule", path);
    const title = requiredString(entry, "title", path);
    const detail = requiredString(entry, "detail", path);
    const suggestion = nullableString(entry, "suggestion", path);

    const rawLocation = entry["location"];
    if (!isRecord(rawLocation)) {
      fail(`${path} "location" must be an object`);
    }
    const location: FindingLocation = {
      sceneIndex: nullablePositiveInt(rawLocation, "sceneIndex", `${path}.location`),
      line: nullablePositiveInt(rawLocation, "line", `${path}.location`),
      character: nullableString(rawLocation, "character", `${path}.location`),
    };

    return {
      id,
      rule,
      category: category as CriticCategory,
      severity: severity as CriticSeverity,
      title,
      detail,
      suggestion,
      location,
    };
  });

  const expectedCounts = countsFromFindings(findings);
  const rawCounts = raw["counts"];
  if (!isRecord(rawCounts)) {
    fail('critique "counts" must be an object');
  }
  for (const category of CRITIC_CATEGORIES) {
    const value = rawCounts[category];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      fail(`critique "counts.${category}" must be a non-negative integer, got ${JSON.stringify(value)}`);
    }
    if (value !== expectedCounts[category]) {
      fail(
        `critique "counts.${category}" is ${value} but findings contain ${expectedCounts[category]}`,
      );
    }
  }
  const extraCountKeys = Object.keys(rawCounts).filter(
    (key) => !(CRITIC_CATEGORIES as readonly string[]).includes(key),
  );
  if (extraCountKeys.length > 0) {
    fail(`critique "counts" has unknown keys: ${extraCountKeys.join(", ")}`);
  }

  const expectedVerdict = verdictFromFindings(findings, reviseOnSeverity);
  if (rawVerdict !== expectedVerdict) {
    fail(
      `critique "verdict" is ${JSON.stringify(rawVerdict)} but findings imply ${JSON.stringify(expectedVerdict)} (reviseOnSeverity=${reviseOnSeverity})`,
    );
  }

  return {
    schemaVersion: SCRIPT_CRITIC_SCHEMA_VERSION,
    screenplayId,
    criticModelId,
    createdAt,
    verdict: rawVerdict as CriticVerdict,
    findings,
    counts: expectedCounts,
  };
}