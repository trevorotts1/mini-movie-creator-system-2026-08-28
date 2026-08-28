/**
 * checkpoint.json schema — the machine-readable durable checkpoint (runbook
 * §5 / PART II §4, spec.md §28 "Durable checkpoint").
 *
 * Minimum field set from runbook §5 (authoritative order preserved):
 *   schemaVersion, project, repoRoot, origin, upstream, integrationBranch,
 *   lastCheckpointAt, lastMergeAt, lastWatchdogAt, currentWave, buildComplete,
 *   activeWorkflowIds, readyTaskIds, blockedTaskIds, mergeQueueTaskIds,
 *   lastKnownGoodCommit.
 *
 * Extended field set from runbook PART II §4 (superset — the runbook states a
 * "minimum" there): currentMainSha, currentIntegrationSha, activeTaskIds,
 * qcTaskIds, activeAgentIds, lastFullRegressionAt, nextActions. Extra fields
 * are additive; the schema version gates structural changes.
 */

export const CHECKPOINT_SCHEMA_VERSION = 1 as const;
export const CHECKPOINT_FILE = "checkpoint.json";

export interface CheckpointState {
  schemaVersion: typeof CHECKPOINT_SCHEMA_VERSION;
  /** Project identifier, e.g. "mini-movie-creator-system-2026-08-28". */
  project: string;
  /** Absolute path of the repo root this checkpoint governs. */
  repoRoot: string;
  origin: string;
  upstream: string;
  /** Branch batch merges land on, e.g. "integration". */
  integrationBranch: string;
  /** ISO-8601 UTC timestamps. */
  lastCheckpointAt: string;
  lastMergeAt: string | null;
  lastWatchdogAt: string | null;
  /** Current dependency wave (runbook §10), 1-based. */
  currentWave: number;
  buildComplete: boolean;
  /** Task IDs grouped by pipeline state (reconstructed on reload). */
  activeWorkflowIds: string[];
  readyTaskIds: string[];
  activeTaskIds: string[];
  qcTaskIds: string[];
  blockedTaskIds: string[];
  mergeQueueTaskIds: string[];
  activeAgentIds: string[];
  /** Last commit where the full build was verified good. */
  lastKnownGoodCommit: string | null;
  currentMainSha: string | null;
  currentIntegrationSha: string | null;
  lastFullRegressionAt: string | null;
  /** Machine-readable next-step hints for resume (runbook PART II §4). */
  nextActions: string[];
}

/** A checkpoint snapshot before any fields are filled in. */
export function emptyCheckpoint(project: string, repoRoot: string): CheckpointState {
  const now = new Date().toISOString();
  return {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    project,
    repoRoot,
    origin: "",
    upstream: "",
    integrationBranch: "integration",
    lastCheckpointAt: now,
    lastMergeAt: null,
    lastWatchdogAt: null,
    currentWave: 1,
    buildComplete: false,
    activeWorkflowIds: [],
    readyTaskIds: [],
    activeTaskIds: [],
    qcTaskIds: [],
    blockedTaskIds: [],
    mergeQueueTaskIds: [],
    activeAgentIds: [],
    lastKnownGoodCommit: null,
    currentMainSha: null,
    currentIntegrationSha: null,
    lastFullRegressionAt: null,
    nextActions: [],
  };
}

/**
 * Validate + normalize a parsed checkpoint document. Returns a fully-shaped
 * CheckpointState, coercing missing/legacy shapes where safe. Throws
 * CheckpointSchemaError on a structurally unusable document (wrong
 * schemaVersion, non-object, arrays where arrays are required).
 */
export class CheckpointSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CheckpointSchemaError";
  }
}

function asStringArray(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new CheckpointSchemaError(
      `checkpoint field "${field}" must be an array of strings`,
    );
  }
  return value as string[];
}

function asIsoStringOrNull(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new CheckpointSchemaError(`checkpoint field "${field}" must be a string`);
  }
  return value;
}

function asString(value: unknown, field: string, fallback = ""): string {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string") {
    throw new CheckpointSchemaError(`checkpoint field "${field}" must be a string`);
  }
  return value;
}

export function normalizeCheckpoint(raw: unknown): CheckpointState {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new CheckpointSchemaError("checkpoint document must be a JSON object");
  }
  const obj = raw as Record<string, unknown>;
  const version = obj.schemaVersion;
  if (typeof version !== "number" || !Number.isInteger(version)) {
    throw new CheckpointSchemaError(
      `checkpoint "schemaVersion" must be a number, got ${JSON.stringify(version)}`,
    );
  }
  if (version > CHECKPOINT_SCHEMA_VERSION) {
    throw new CheckpointSchemaError(
      `checkpoint schemaVersion ${version} is newer than supported ${CHECKPOINT_SCHEMA_VERSION}`,
    );
  }
  return {
    schemaVersion: version as typeof CHECKPOINT_SCHEMA_VERSION,
    project: asString(obj.project, "project"),
    repoRoot: asString(obj.repoRoot, "repoRoot"),
    origin: asString(obj.origin, "origin"),
    upstream: asString(obj.upstream, "upstream"),
    integrationBranch: asString(obj.integrationBranch, "integrationBranch", "integration"),
    lastCheckpointAt: asIsoStringOrNull(obj.lastCheckpointAt, "lastCheckpointAt") ?? "",
    lastMergeAt: asIsoStringOrNull(obj.lastMergeAt, "lastMergeAt"),
    lastWatchdogAt: asIsoStringOrNull(obj.lastWatchdogAt, "lastWatchdogAt"),
    currentWave:
      typeof obj.currentWave === "number" && Number.isInteger(obj.currentWave)
        ? obj.currentWave
        : 1,
    buildComplete: obj.buildComplete === true,
    activeWorkflowIds: asStringArray(obj.activeWorkflowIds, "activeWorkflowIds"),
    readyTaskIds: asStringArray(obj.readyTaskIds, "readyTaskIds"),
    activeTaskIds: asStringArray(obj.activeTaskIds, "activeTaskIds"),
    qcTaskIds: asStringArray(obj.qcTaskIds, "qcTaskIds"),
    blockedTaskIds: asStringArray(obj.blockedTaskIds, "blockedTaskIds"),
    mergeQueueTaskIds: asStringArray(obj.mergeQueueTaskIds, "mergeQueueTaskIds"),
    activeAgentIds: asStringArray(obj.activeAgentIds, "activeAgentIds"),
    lastKnownGoodCommit: asIsoStringOrNull(obj.lastKnownGoodCommit, "lastKnownGoodCommit"),
    currentMainSha: asIsoStringOrNull(obj.currentMainSha, "currentMainSha"),
    currentIntegrationSha: asIsoStringOrNull(obj.currentIntegrationSha, "currentIntegrationSha"),
    lastFullRegressionAt: asIsoStringOrNull(obj.lastFullRegressionAt, "lastFullRegressionAt"),
    nextActions: asStringArray(obj.nextActions, "nextActions"),
  };
}

/**
 * Deduplicated, order-preserving task-id list — used by the writers so a
 * reload reconstructs exactly the ids that were recorded.
 */
export function uniqueIds(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}