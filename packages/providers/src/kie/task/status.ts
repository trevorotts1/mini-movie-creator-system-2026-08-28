import type {
  KiePipelineState,
  KieTaskInfo,
  KieTaskStatus,
} from "./types.js";

/**
 * Fold a raw Kie status string into the normalized status union.
 *
 * Kie's documented task states (docs.kie.ai, verified against the task-info
 * endpoint family): `waiting`, `queuing`, `generating` (in-flight), `success`
 * (or `succeeded`), `fail` (or `failed`). Unknown values map to "waiting"
 * (still in flight) rather than inventing a terminal state — an unknown
 * provider string must never be read as success or failure.
 */
export function normalizeKieStatus(raw: string): KieTaskStatus {
  const value = raw.trim().toLowerCase();
  switch (value) {
    case "success":
    case "succeeded":
      return "success";
    case "fail":
    case "failed":
    case "error":
      return "failed";
    case "running":
    case "generating":
      return "running";
    case "waiting":
    case "queued":
    case "queuing":
    case "pending":
      return "waiting";
    default:
      // Unknown → in-flight; never guess a terminal state.
      return "waiting";
  }
}

/**
 * Extract result URLs from the raw `result` payload. Kie returns either a
 * `resultJson.resultUrls` array (video models) or a bare URL string/array —
 * accept both shapes, return a flat list of http(s) URLs. Returns [] when the
 * payload is absent or holds no URLs.
 */
export function parseResultUrls(result: unknown): string[] {
  if (typeof result === "string") {
    return isHttpUrl(result) ? [result] : [];
  }
  if (!result || typeof result !== "object") return [];
  const record = result as Record<string, unknown>;

  const nested =
    record["resultUrls"] ??
    record["resultJson"] ??
    record["result_json"] ??
    undefined;
  const list = firstUrlList(result) ?? (nested !== undefined ? firstUrlList(nested) : undefined) ?? [];
  return list;
}

function firstUrlList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string" && isHttpUrl(entry));
  }
  if (value && typeof value === "object") {
    const inner = (value as Record<string, unknown>)["resultUrls"];
    if (Array.isArray(inner)) {
      return inner.filter((entry): entry is string => typeof entry === "string" && isHttpUrl(entry));
    }
  }
  return undefined;
}

function isHttpUrl(value: string): boolean {
  return value.startsWith("http://") || value.startsWith("https://");
}

/**
 * Map a raw task-info payload onto the runbook §21 pipeline machine.
 *
 * - success + URLs → GENERATED_TEMPORARY (URLs are temporary; KIE-008 archives)
 * - success without URLs → REJECTED (cannot archive nothing; surface as failure)
 * - failed → REJECTED with failure detail
 * - waiting/running/unknown → GENERATING (still in flight)
 */
export function mapToPipelineState(info: KieTaskInfo): {
  state: KiePipelineState;
  resultUrls?: string[];
  failure?: { message: string; code?: number; raw: unknown };
} {
  const status = normalizeKieStatus(info.state);
  if (status === "success") {
    const urls = parseResultUrls(info.result);
    if (urls.length > 0) {
      return { state: "GENERATED_TEMPORARY", resultUrls: urls };
    }
    return {
      state: "REJECTED",
      failure: {
        message: "Kie task reported success but returned no result URLs",
        raw: info.result,
      },
    };
  }
  if (status === "failed") {
    return {
      state: "REJECTED",
      failure: {
        message: info.failMsg ?? "Kie task failed",
        code: info.failCode,
        raw: info,
      },
    };
  }
  return { state: "GENERATING" };
}