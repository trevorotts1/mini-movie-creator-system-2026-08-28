/**
 * GHL-012 tests — provider temporary URL emergency archival (spec §17/§18,
 * runbook §14.3/§23). All I/O is mocked; no real network, no credentials.
 *
 * Core acceptance invariants under test:
 * - restart at GENERATED_TEMPORARY archives the known provider URL
 *   immediately when valid — the SAME URL is handed through, never
 *   regenerated (the module has no generation capability at all);
 * - an expired-URL path falls back to the documented BLOCKED state, never
 *   silent regeneration;
 * - every non-archived path is BLOCKED with a machine-readable reason and
 *   the preserved provider task ID.
 */
import { describe, expect, it, vi } from "vitest";

import {
  EMERGENCY_BLOCK_NEXT_ACTIONS,
  EMERGENCY_BLOCK_REASONS,
  EmergencyArchivalError,
  isProviderUrlExpired,
  resumeEmergencyArchival,
  type EmergencyArchivalRecord,
  type EmergencyHostedArchiveRequest,
  type EmergencyHostedArchiveResult,
  type EmergencyUrlProbeResponse,
} from "./index.js";

const FIXED_NOW = Date.parse("2026-08-28T16:00:00.000Z");

function baseRecord(overrides: Partial<EmergencyArchivalRecord> = {}): EmergencyArchivalRecord {
  return {
    state: "GENERATED_TEMPORARY",
    providerTaskId: "kie-task-12345",
    providerUrl: "https://cdn.kie.example/tmp/result-abc.mp4",
    providerUrlExpiresAt: "2026-08-28T18:00:00.000Z", // 2h after FIXED_NOW
    name: "S01E03_SC04_SH07_monica_closeup_agnes25_v03.mp4",
    parentId: "folder-episode-06",
    altId: "LOC123",
    ...overrides,
  };
}

function archivedResult(
  overrides: Partial<EmergencyHostedArchiveResult> = {},
): EmergencyHostedArchiveResult {
  return {
    status: "ARCHIVED",
    fileId: "file-999",
    url: "https://files.gohighlevel.example/storage/file-999.mp4",
    name: "S01E03_SC04_SH07_monica_closeup_agnes25_v03.mp4",
    ...overrides,
  };
}

function makeHosted(
  behavior:
    | "ok"
    | "throw"
    | ((request: EmergencyHostedArchiveRequest) => Promise<EmergencyHostedArchiveResult>),
): ((request: EmergencyHostedArchiveRequest) => Promise<EmergencyHostedArchiveResult>) & {
  calls: EmergencyHostedArchiveRequest[];
} {
  const calls: EmergencyHostedArchiveRequest[] = [];
  const fn = (async (request: EmergencyHostedArchiveRequest) => {
    calls.push(request);
    if (behavior === "throw") {
      throw new Error("[UNREACHABLE] GHL storage URL failed reachability verification");
    }
    if (typeof behavior === "function") return behavior(request);
    return archivedResult();
  }) as ((request: EmergencyHostedArchiveRequest) => Promise<EmergencyHostedArchiveResult>) & {
    calls: EmergencyHostedArchiveRequest[];
  };
  fn.calls = calls;
  return fn;
}

function makeProbe(
  status: number,
  ok = status >= 200 && status < 300,
): { probe: (url: string) => Promise<EmergencyUrlProbeResponse>; urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    probe: async (url: string) => {
      urls.push(url);
      return { ok, status };
    },
  };
}

/** Happy-path probe; the hosted adapter must still be the archival authority. */
function okProbe() {
  return makeProbe(200, true);
}

describe("isProviderUrlExpired — pure expiration decision", () => {
  it("knows a parseable past timestamp is expired", () => {
    expect(
      isProviderUrlExpired("2026-08-28T15:00:00.000Z", FIXED_NOW),
    ).toBe(true);
  });

  it("treats exactly-now as expired (expiredAt <= now)", () => {
    expect(
      isProviderUrlExpired("2026-08-28T16:00:00.000Z", FIXED_NOW),
    ).toBe(true);
  });

  it("knows a future timestamp is not expired", () => {
    expect(
      isProviderUrlExpired("2026-08-28T18:00:00.000Z", FIXED_NOW),
    ).toBe(false);
  });

  it("returns unknown (null) for absent/blank/unparseable values", () => {
    expect(isProviderUrlExpired(undefined, FIXED_NOW)).toBeNull();
    expect(isProviderUrlExpired(null, FIXED_NOW)).toBeNull();
    expect(isProviderUrlExpired("", FIXED_NOW)).toBeNull();
    expect(isProviderUrlExpired("not-a-date", FIXED_NOW)).toBeNull();
  });
});

describe("resumeEmergencyArchival — restart at GENERATED_TEMPORARY", () => {
  it("archives the persisted URL immediately: passes the SAME URL through hosted ingest (never regenerates)", async () => {
    const hosted = makeHosted("ok");
    const probe = okProbe();
    const outcome = await resumeEmergencyArchival(baseRecord(), hosted, {
      now: () => FIXED_NOW,
      probe: probe.probe,
    });
    expect(outcome.status).toBe("ARCHIVED");
    if (outcome.status !== "ARCHIVED") return; // narrowing for assertions below
    expect(outcome.fileId).toBe("file-999");
    expect(outcome.url).toBe("https://files.gohighlevel.example/storage/file-999.mp4");
    // The exact persisted URL was handed to the ingest — no regeneration.
    expect(hosted.calls).toHaveLength(1);
    expect(hosted.calls[0]?.fileUrl).toBe("https://cdn.kie.example/tmp/result-abc.mp4");
    expect(hosted.calls[0]?.name).toBe("S01E03_SC04_SH07_monica_closeup_agnes25_v03.mp4");
    expect(hosted.calls[0]?.parentId).toBe("folder-episode-06");
    expect(hosted.calls[0]?.altId).toBe("LOC123");
  });

  it("is immediate: probes once, no retry loop, single archival attempt", async () => {
    const hosted = makeHosted("ok");
    const probe = okProbe();
    await resumeEmergencyArchival(baseRecord(), hosted, {
      now: () => FIXED_NOW,
      probe: probe.probe,
    });
    expect(probe.urls).toHaveLength(1);
    expect(probe.urls[0]).toBe("https://cdn.kie.example/tmp/result-abc.mp4");
    expect(hosted.calls).toHaveLength(1);
  });
});

describe("resumeEmergencyArchival — expired URL falls back to documented BLOCKED", () => {
  it("BLOCKED EXPIRED_URL without any network attempt (no probe, no ingest)", async () => {
    const hosted = makeHosted("ok");
    const probe = okProbe();
    const outcome = await resumeEmergencyArchival(
      baseRecord({ providerUrlExpiresAt: "2026-08-28T15:00:00.000Z" }),
      hosted,
      { now: () => FIXED_NOW, probe: probe.probe },
    );
    expect(outcome.status).toBe("BLOCKED");
    if (outcome.status !== "BLOCKED") return;
    expect(outcome.reason).toBe("EXPIRED_URL");
    expect(outcome.providerTaskId).toBe("kie-task-12345");
    expect(outcome.providerUrl).toBe("https://cdn.kie.example/tmp/result-abc.mp4");
    expect(outcome.blockedAt).toBe("2026-08-28T16:00:00.000Z");
    expect(outcome.nextAction).toBe(EMERGENCY_BLOCK_NEXT_ACTIONS.EXPIRED_URL);
    expect(outcome.nextAction).toMatch(/never regenerate automatically/i);
    // No network, no ingest — the expired URL never gets a request.
    expect(probe.urls).toHaveLength(0);
    expect(hosted.calls).toHaveLength(0);
  });

  it("BLOCKED EXPIRED_URL is the documented state, not a silent path — the reason+nextAction are machine-usable", async () => {
    const hosted = makeHosted("ok");
    const outcome = await resumeEmergencyArchival(
      baseRecord({ providerUrlExpiresAt: "2026-01-01T00:00:00.000Z" }),
      hosted,
      { now: () => FIXED_NOW },
    );
    expect(outcome.status).toBe("BLOCKED");
    if (outcome.status !== "BLOCKED") return;
    expect(EMERGENCY_BLOCK_REASONS).toContain(outcome.reason);
    expect(EMERGENCY_BLOCK_NEXT_ACTIONS[outcome.reason]).toBe(outcome.nextAction);
  });

  it("unparseable expiration is NOT trusted as expired — falls through to the reachability probe", async () => {
    const hosted = makeHosted("ok");
    const probe = okProbe();
    const outcome = await resumeEmergencyArchival(
      baseRecord({ providerUrlExpiresAt: "definitely not a date" }),
      hosted,
      { now: () => FIXED_NOW, probe: probe.probe },
    );
    expect(outcome.status).toBe("ARCHIVED");
    expect(probe.urls).toHaveLength(1);
  });

  it("absent expiration is unknown, not expired — decided by the probe", async () => {
    const hosted = makeHosted("ok");
    const probe = okProbe();
    const outcome = await resumeEmergencyArchival(
      baseRecord({ providerUrlExpiresAt: undefined }),
      hosted,
      { now: () => FIXED_NOW, probe: probe.probe },
    );
    expect(outcome.status).toBe("ARCHIVED");
    expect(probe.urls).toHaveLength(1);
  });
});

describe("resumeEmergencyArchival — BLOCKED paths never regenerate", () => {
  it("missing provider URL → BLOCKED MISSING_PROVIDER_URL, no probe, no ingest", async () => {
    const hosted = makeHosted("ok");
    const probe = okProbe();
    for (const providerUrl of [undefined, null, "", "   "]) {
      const outcome = await resumeEmergencyArchival(
        baseRecord({ providerUrl: providerUrl as string | null | undefined }),
        hosted,
        { now: () => FIXED_NOW, probe: probe.probe },
      );
      expect(outcome.status).toBe("BLOCKED");
      if (outcome.status !== "BLOCKED") return;
      expect(outcome.reason).toBe("MISSING_PROVIDER_URL");
      expect(outcome.providerTaskId).toBe("kie-task-12345");
      expect(outcome.nextAction).toMatch(/never regenerate automatically/i);
    }
    expect(probe.urls).toHaveLength(0);
    expect(hosted.calls).toHaveLength(0);
  });

  it("non-http(s) URL → BLOCKED URL_INVALID, no network", async () => {
    const hosted = makeHosted("ok");
    const probe = okProbe();
    for (const providerUrl of ["ftp://cdn.example/f.mp4", "file:///tmp/x.mp4"]) {
      const outcome = await resumeEmergencyArchival(
        baseRecord({ providerUrl }),
        hosted,
        { now: () => FIXED_NOW, probe: probe.probe },
      );
      expect(outcome.status).toBe("BLOCKED");
      if (outcome.status !== "BLOCKED") return;
      expect(outcome.reason).toBe("URL_INVALID");
    }
    expect(probe.urls).toHaveLength(0);
    expect(hosted.calls).toHaveLength(0);
  });

  it("unparseable URL → BLOCKED URL_INVALID", async () => {
    const hosted = makeHosted("ok");
    const outcome = await resumeEmergencyArchival(
      baseRecord({ providerUrl: "::not a url::" }),
      hosted,
      { now: () => FIXED_NOW },
    );
    expect(outcome.status).toBe("BLOCKED");
    if (outcome.status !== "BLOCKED") return;
    expect(outcome.reason).toBe("URL_INVALID");
    expect(hosted.calls).toHaveLength(0);
  });

  it("probe non-2xx → BLOCKED URL_UNREACHABLE with probe status preserved", async () => {
    const hosted = makeHosted("ok");
    const probe = makeProbe(403, false);
    const outcome = await resumeEmergencyArchival(baseRecord(), hosted, {
      now: () => FIXED_NOW,
      probe: probe.probe,
    });
    expect(outcome.status).toBe("BLOCKED");
    if (outcome.status !== "BLOCKED") return;
    expect(outcome.reason).toBe("URL_UNREACHABLE");
    expect(outcome.detail).toContain("403");
    expect(outcome.providerTaskId).toBe("kie-task-12345");
    expect(hosted.calls).toHaveLength(0);
  });

  it("probe network error → BLOCKED URL_UNREACHABLE, ingest never called", async () => {
    const hosted = makeHosted("ok");
    const probe = {
      probe: async () => {
        throw new Error("ECONNREFUSED");
      },
    };
    const outcome = await resumeEmergencyArchival(baseRecord(), hosted, {
      now: () => FIXED_NOW,
      probe: probe.probe,
    });
    expect(outcome.status).toBe("BLOCKED");
    if (outcome.status !== "BLOCKED") return;
    expect(outcome.reason).toBe("URL_UNREACHABLE");
    expect(hosted.calls).toHaveLength(0);
  });

  it("hosted ingest throws (e.g. GHL-005 UNREACHABLE) → BLOCKED HOSTED_INGEST_FAILED carrying the ingest error", async () => {
    const hosted = makeHosted("throw");
    const probe = okProbe();
    const outcome = await resumeEmergencyArchival(baseRecord(), hosted, {
      now: () => FIXED_NOW,
      probe: probe.probe,
    });
    expect(outcome.status).toBe("BLOCKED");
    if (outcome.status !== "BLOCKED") return;
    expect(outcome.reason).toBe("HOSTED_INGEST_FAILED");
    expect(outcome.detail).toContain("GHL storage URL failed reachability");
    expect(outcome.providerTaskId).toBe("kie-task-12345");
    expect(outcome.nextAction).toMatch(/binary fallback/i);
  });

  it("hosted ingest returning a non-ARCHIVED result → BLOCKED HOSTED_INGEST_FAILED", async () => {
    const hosted = makeHosted(async () => {
      // A malformed/ambiguous adapter result is never treated as success.
      return { status: "PENDING", fileId: "", url: "" } as unknown as EmergencyHostedArchiveResult;
    });
    const probe = okProbe();
    const outcome = await resumeEmergencyArchival(baseRecord(), hosted, {
      now: () => FIXED_NOW,
      probe: probe.probe,
    });
    expect(outcome.status).toBe("BLOCKED");
    if (outcome.status !== "BLOCKED") return;
    expect(outcome.reason).toBe("HOSTED_INGEST_FAILED");
  });

  it("hosted ingest ARCHIVED with empty fileId → BLOCKED HOSTED_INGEST_FAILED (never persist ARCHIVED without a fileId)", async () => {
    const hosted = makeHosted(async () =>
      archivedResult({ fileId: "", url: "https://files.gohighlevel.example/storage/file-999.mp4" }),
    );
    const probe = okProbe();
    const outcome = await resumeEmergencyArchival(baseRecord(), hosted, {
      now: () => FIXED_NOW,
      probe: probe.probe,
    });
    expect(outcome.status).toBe("BLOCKED");
    if (outcome.status !== "BLOCKED") return;
    expect(outcome.reason).toBe("HOSTED_INGEST_FAILED");
    expect(outcome.detail).toContain("empty fileId");
  });

  it("hosted ingest ARCHIVED with blank/missing storage URL → BLOCKED HOSTED_INGEST_FAILED", async () => {
    const probe = okProbe();
    for (const url of ["", "   "]) {
      const hosted = makeHosted(async () =>
        archivedResult({ fileId: "file-999", url }),
      );
      const outcome = await resumeEmergencyArchival(baseRecord(), hosted, {
        now: () => FIXED_NOW,
        probe: probe.probe,
      });
      expect(outcome.status).toBe("BLOCKED");
      if (outcome.status !== "BLOCKED") return;
      expect(outcome.reason).toBe("HOSTED_INGEST_FAILED");
      expect(outcome.detail).toContain("empty storage URL");
    }
  });

  it("hosted ingest ARCHIVED with non-http(s) storage URL → BLOCKED HOSTED_INGEST_FAILED", async () => {
    const hosted = makeHosted(async () =>
      archivedResult({ fileId: "file-999", url: "ftp://files.example/f.mp4" }),
    );
    const probe = okProbe();
    const outcome = await resumeEmergencyArchival(baseRecord(), hosted, {
      now: () => FIXED_NOW,
      probe: probe.probe,
    });
    expect(outcome.status).toBe("BLOCKED");
    if (outcome.status !== "BLOCKED") return;
    expect(outcome.reason).toBe("HOSTED_INGEST_FAILED");
    expect(outcome.detail).toContain("non-http(s)");
  });

  it("hosted ingest ARCHIVED with unparseable storage URL → BLOCKED HOSTED_INGEST_FAILED", async () => {
    const hosted = makeHosted(async () =>
      archivedResult({ fileId: "file-999", url: "::not a url::" }),
    );
    const probe = okProbe();
    const outcome = await resumeEmergencyArchival(baseRecord(), hosted, {
      now: () => FIXED_NOW,
      probe: probe.probe,
    });
    expect(outcome.status).toBe("BLOCKED");
    if (outcome.status !== "BLOCKED") return;
    expect(outcome.reason).toBe("HOSTED_INGEST_FAILED");
    expect(outcome.detail).toContain("unparseable storage URL");
  });

  it("hosted ingest ARCHIVED with empty/blank name → BLOCKED HOSTED_INGEST_FAILED (canonical name is part of the payload contract, spec §19)", async () => {
    const probe = okProbe();
    for (const name of ["", "   "]) {
      const hosted = makeHosted(async () =>
        archivedResult({ fileId: "file-999", name }),
      );
      const outcome = await resumeEmergencyArchival(baseRecord(), hosted, {
        now: () => FIXED_NOW,
        probe: probe.probe,
      });
      expect(outcome.status).toBe("BLOCKED");
      if (outcome.status !== "BLOCKED") return;
      expect(outcome.reason).toBe("HOSTED_INGEST_FAILED");
      expect(outcome.detail).toContain("empty name");
    }
  });
});

describe("resumeEmergencyArchival — entry-state gate", () => {
  it("resumes from ARCHIVING (crash mid-archival)", async () => {
    const hosted = makeHosted("ok");
    const probe = okProbe();
    const outcome = await resumeEmergencyArchival(
      baseRecord({ state: "ARCHIVING" }),
      hosted,
      { now: () => FIXED_NOW, probe: probe.probe },
    );
    expect(outcome.status).toBe("ARCHIVED");
  });

  it("throws INVALID_ENTRY_STATE at ARCHIVED — never re-archives", async () => {
    const hosted = makeHosted("ok");
    await expect(
      resumeEmergencyArchival(
        baseRecord({ state: "ARCHIVED" }),
        hosted,
        { now: () => FIXED_NOW },
      ),
    ).rejects.toMatchObject({
      name: "EmergencyArchivalError",
      code: "INVALID_ENTRY_STATE",
    });
    expect(hosted.calls).toHaveLength(0);
  });

  it("throws INVALID_ENTRY_STATE at SUBMITTED/GENERATING — that is the poll runner's layer", async () => {
    const hosted = makeHosted("ok");
    for (const state of ["SUBMITTED", "GENERATING", "PLANNED"]) {
      await expect(
        resumeEmergencyArchival(baseRecord({ state }), hosted, { now: () => FIXED_NOW }),
      ).rejects.toMatchObject({
        name: "EmergencyArchivalError",
        code: "INVALID_ENTRY_STATE",
      });
    }
    expect(hosted.calls).toHaveLength(0);
  });
});

describe("resumeEmergencyArchival — record validation", () => {
  it("throws INVALID_RECORD without providerTaskId (spec §18: persist before polling)", async () => {
    const hosted = makeHosted("ok");
    for (const providerTaskId of [undefined, "", "   "]) {
      await expect(
        resumeEmergencyArchival(
          baseRecord({ providerTaskId: providerTaskId as string | undefined }),
          hosted,
          { now: () => FIXED_NOW },
        ),
      ).rejects.toMatchObject({ code: "INVALID_RECORD" });
    }
    expect(hosted.calls).toHaveLength(0);
  });

  it("throws INVALID_RECORD without name or parentId", async () => {
    const hosted = makeHosted("ok");
    await expect(
      resumeEmergencyArchival(baseRecord({ name: "" }), hosted, { now: () => FIXED_NOW }),
    ).rejects.toMatchObject({ code: "INVALID_RECORD" });
    await expect(
      resumeEmergencyArchival(baseRecord({ parentId: "" }), hosted, { now: () => FIXED_NOW }),
    ).rejects.toMatchObject({ code: "INVALID_RECORD" });
  });
});

describe("resumeEmergencyArchival — no regeneration capability", () => {
  it("never receives or produces a generate/submit/poll call — only the hosted archive port", async () => {
    // The module's only dependency is the hosted archive port. Any attempted
    // "regeneration" would have to appear as extra calls; assert exactly one
    // call and that the record's provider task ID is never sent to GHL.
    const hosted = makeHosted("ok");
    const probe = okProbe();
    const outcome = await resumeEmergencyArchival(baseRecord(), hosted, {
      now: () => FIXED_NOW,
      probe: probe.probe,
    });
    expect(outcome.status).toBe("ARCHIVED");
    expect(hosted.calls).toHaveLength(1);
    expect(JSON.stringify(hosted.calls[0])).not.toContain("kie-task-12345");
  });

  it("BLOCKED outcomes always preserve the provider task ID", async () => {
    const hosted = makeHosted("throw");
    const probe = makeProbe(500, false);
    for (const record of [
      baseRecord({ providerUrl: undefined }),
      baseRecord({ providerUrl: "ftp://x/y.mp4" }),
      baseRecord({ providerUrlExpiresAt: "2020-01-01T00:00:00.000Z" }),
      baseRecord(),
      baseRecord(),
    ] as const) {
      const outcome = await resumeEmergencyArchival(record, hosted, {
        now: () => FIXED_NOW,
        probe: probe.probe,
      });
      expect(outcome.status).toBe("BLOCKED");
      if (outcome.status !== "BLOCKED") return;
      expect(outcome.providerTaskId).toBe("kie-task-12345");
    }
  });
});

describe("default probe wiring", () => {
  it("probes with HEAD by default and honors a GET override", async () => {
    const seenMethods: Array<string | undefined> = [];
    const probe = async (
      _url: string,
      init?: { method?: "HEAD" | "GET"; signal?: AbortSignal },
    ) => {
      seenMethods.push(init?.method);
      return { ok: true, status: 200 } satisfies EmergencyUrlProbeResponse;
    };
    await resumeEmergencyArchival(baseRecord(), makeHosted("ok"), {
      now: () => FIXED_NOW,
      probe,
    });
    expect(seenMethods).toEqual(["HEAD"]);

    const seenMethodsGet: Array<string | undefined> = [];
    const probeGet = async (
      _url: string,
      init?: { method?: "HEAD" | "GET"; signal?: AbortSignal },
    ) => {
      seenMethodsGet.push(init?.method);
      return { ok: true, status: 200 } satisfies EmergencyUrlProbeResponse;
    };
    await resumeEmergencyArchival(baseRecord(), makeHosted("ok"), {
      now: () => FIXED_NOW,
      probe: probeGet,
      probeMethod: "GET",
    });
    expect(seenMethodsGet).toEqual(["GET"]);
  });
});

describe("time behavior", () => {
  it("uses the injected clock for blockedAt and expiration", async () => {
    const hosted = makeHosted("ok");
    const clock = vi.fn(() => FIXED_NOW);
    const outcome = await resumeEmergencyArchival(
      baseRecord({ providerUrlExpiresAt: "2020-01-01T00:00:00.000Z" }),
      hosted,
      { now: clock, probe: okProbe().probe },
    );
    expect(clock).toHaveBeenCalled();
    expect(outcome.status).toBe("BLOCKED");
    if (outcome.status !== "BLOCKED") return;
    expect(outcome.blockedAt).toBe("2026-08-28T16:00:00.000Z");
  });

  it("blockedAt is read at RECORD time, after the probe/ingest awaits — not the pre-I/O reading", async () => {
    // Clock advances 10s on every read (probe + ingest each burn ~10s).
    let tick = FIXED_NOW;
    const clock = vi.fn(() => {
      tick += 10_000;
      return tick;
    });
    const probe = okProbe();
    const outcome = await resumeEmergencyArchival(
      baseRecord({ providerUrl: "https://cdn.kie.example/tmp/result-abc.mp4" }),
      makeHosted(async () => {
        throw new Error("[UNREACHABLE] GHL storage URL failed reachability verification");
      }),
      { now: clock, probe: probe.probe },
    );
    expect(outcome.status).toBe("BLOCKED");
    if (outcome.status !== "BLOCKED") return;
    expect(outcome.reason).toBe("HOSTED_INGEST_FAILED");
    // Clock reads: 16:00:10 (pre-I/O) … then 16:00:20 when the block is
    // RECORDED, after the probe and ingest awaits. A stale pre-I/O
    // blockedAt would be 16:00:10.
    expect(outcome.blockedAt).toBe("2026-08-28T16:00:20.000Z");
  });
});