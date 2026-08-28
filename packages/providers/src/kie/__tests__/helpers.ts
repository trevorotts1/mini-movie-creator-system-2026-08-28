/// <reference types="node" />
/**
 * KIE-010 — shared doubles for the mocked contract suite.
 *
 * These helpers pin the seams between the three Kie modules:
 *   - `KieFetch` script (KIE-001 transport) — canned HTTP responses in order.
 *   - `KieTaskStore` memory impl (KIE-002 persistence port) — with save trace.
 *   - client→port adapter — proves the KIE-001 `KieClient` satisfies the
 *     KIE-002 `KieTaskClient` port over the real wire shapes (envelope,
 *     `resultJson` string parsing, failCode string→number).
 * A production adapter may live in a later task; this one documents the
 * contract both sides must honor and keeps the suite self-contained.
 */
import type {
  KieFetch,
  KieClient,
  KieCreateTaskData,
  KieRecordInfoData,
} from "../client/index.js";
import type {
  KieCreateTaskRequest,
  KieCreateTaskResponse,
  KieTaskClient,
  KieTaskInfo,
  KieTaskRecord,
  KieTaskStore,
} from "../task/index.js";

/** A scripted HTTP outcome: either a Response or an error to throw. */
export type ScriptedOutcome = Response | Error;

/** Documented success envelope (docs.kie.ai, verified 2026-08-28). */
export function envelope(data: unknown, code = 200, msg = "success"): Record<string, unknown> {
  return { code, msg, data };
}

export function jsonResponse(
  status: number,
  body: unknown,
  headers?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

/** Build a fetch double that replays `script` in order and records every call. */
export function scriptedFetch(script: ScriptedOutcome[]): {
  fetch: KieFetch;
  calls: Array<{ url: string; init: RequestInit }>;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch: KieFetch = async (url, init) => {
    calls.push({ url, init });
    const next = script.shift();
    if (next instanceof Response) return next;
    throw next ?? new Error("script exhausted");
  };
  return { fetch, calls };
}

/** In-memory KieTaskStore with full save-order trace (for persist-before-poll). */
export function memoryStore(seed: KieTaskRecord[] = []): KieTaskStore & {
  rows: Map<string, KieTaskRecord>;
  saveOrder: KieTaskRecord[];
} {
  const rows = new Map<string, KieTaskRecord>();
  const saveOrder: KieTaskRecord[] = [];
  for (const record of seed) rows.set(record.ref, { ...record });
  return {
    rows,
    saveOrder,
    async load(ref) {
      return rows.get(ref);
    },
    async save(record) {
      saveOrder.push({ ...record });
      rows.set(record.ref, { ...record });
    },
  };
}

/** Deterministic ISO clock: each call advances 1s from a fixed epoch. */
export function steppedClock(): () => string {
  let tick = 0;
  return () => new Date(1_700_000_000_000 + tick++ * 1000).toISOString();
}

export const instantSleep = async (): Promise<void> => {};

/** Scripted KieTaskClient double: counts createTask calls, replays getTask infos. */
export function scriptedTaskClient(
  taskId: string,
  infos: KieTaskInfo[],
  calls: { createCount: number; pollIds: string[] } = { createCount: 0, pollIds: [] },
): KieTaskClient {
  let pollIndex = 0;
  return {
    async createTask(): Promise<KieCreateTaskResponse> {
      calls.createCount += 1;
      return { taskId };
    },
    async getTask(id: string): Promise<KieTaskInfo> {
      calls.pollIds.push(id);
      const info = infos[Math.min(pollIndex, infos.length - 1)];
      pollIndex += 1;
      if (!info) throw new Error(`no scripted info for ${id}`);
      return info;
    },
  };
}

/**
 * Adapter: use the real KIE-001 KieClient as a KIE-002 KieTaskClient.
 * This is the seam contract under test — envelope unwrap, `resultJson`
 * JSON-string parsing, and failCode string→number normalization all happen
 * here, exactly as a production adapter must do them.
 */
export function kieClientAsTaskClient(client: KieClient): KieTaskClient {
  return {
    async createTask(request: KieCreateTaskRequest): Promise<KieCreateTaskResponse> {
      const result = await client.createTask({
        model: request.model,
        input: request.input,
        ...(request.callBackUrl !== undefined ? { callBackUrl: request.callBackUrl } : {}),
      });
      if (!result.ok) throw result.error;
      const data = result.data as KieCreateTaskData;
      if (!data || typeof data.taskId !== "string") {
        throw new Error(`Kie createTask returned no taskId (msg: ${result.msg})`);
      }
      return { taskId: data.taskId };
    },
    async getTask(taskId: string): Promise<KieTaskInfo> {
      const result = await client.recordInfo(taskId);
      if (!result.ok) throw result.error;
      const data = result.data as KieRecordInfoData;
      let resultPayload: unknown = data.resultJson;
      if (typeof data.resultJson === "string") {
        try {
          resultPayload = JSON.parse(data.resultJson);
        } catch {
          resultPayload = data.resultJson; // keep raw; mapping layer tolerates it
        }
      }
      return {
        taskId: data.taskId ?? taskId,
        state: data.state ?? "",
        result: resultPayload,
        // Empty-string failMsg (documented as settable-but-blank) must fall
        // through to the mapping layer's default message, not win the ??.
        failMsg: data.failMsg ? data.failMsg : undefined,
        failCode:
          typeof data.failCode === "string" && data.failCode !== ""
            ? Number.parseInt(data.failCode, 10) || undefined
            : undefined,
      };
    },
  };
}