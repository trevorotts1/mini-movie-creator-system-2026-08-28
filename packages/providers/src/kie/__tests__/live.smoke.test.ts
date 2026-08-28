/// <reference types="node" />
/**
 * KIE-010 — optional live smoke against api.kie.ai.
 *
 * GATED: runs ONLY when all three hold —
 *   1. MMCS_LIVE_SMOKE=1 is set (explicit opt-in), AND
 *   2. KIE_API_KEY is present in the environment, AND
 *   3. the operator has accepted the $25 auto-spend rule for this environment
 *      (MMCS_LIVE_SMOKE implies acceptance; the smoke makes at most ONE
 *      cheapest-possible generation request and one poll — see runbook §33:
 *      below $25.00 cumulative paid spend may proceed automatically).
 *
 * Without the gate variables the suite SKIPS cleanly (never fails CI).
 * This file performs real network calls ONLY when the gate opens.
 */
/// <reference types="node" />
import { describe, expect, it } from "vitest";
import { KieClient } from "../client/index.js";
import { KieTaskRunner, type KieTaskStore } from "../task/index.js";
import { kieClientAsTaskClient, memoryStore } from "./helpers.js";

const LIVE_GATE = process.env.MMCS_LIVE_SMOKE === "1";
const LIVE_KEY = process.env.KIE_API_KEY;
const LIVE_ENABLED = LIVE_GATE && typeof LIVE_KEY === "string" && LIVE_KEY.length > 0;

const d = LIVE_ENABLED ? describe : describe.skip;

d("KIE-010 live smoke (gated: MMCS_LIVE_SMOKE=1 + KIE_API_KEY; $25 rule acknowledged)", () => {
  it(
    "cheapest real round-trip: createTask → persist → poll once (no generation beyond the single task)",
    { timeout: 60_000 },
    async () => {
      // Seedance 2 Mini text-to-video, minimum duration, lowest resolution,
      // 4-second clip: the cheapest documented generation unit. In-memory
      // store: the live smoke is single-shot; a durable store is the
      // production path (KIE-008/CORE-007) and out of scope here.
      const client = new KieClient({ apiKey: LIVE_KEY as string });
      const store = memoryStore();
      const runner = new KieTaskRunner(kieClientAsTaskClient(client), store satisfies KieTaskStore);

      const submitted = await runner.ensureSubmitted("live-smoke:single", {
        model: "bytedance/seedance-2-mini",
        input: {
          prompt: "a single red balloon drifting over a quiet city at dawn",
          aspect_ratio: "9:16",
          resolution: "480p",
          duration: 4,
        },
      });

      // Contract under test, against the real API:
      expect(typeof submitted.providerTaskId).toBe("string");
      expect(submitted.providerTaskId!.length).toBeGreaterThan(0);
      expect(submitted.state).toBe("SUBMITTED");

      // One poll — we do NOT wait for completion in the smoke; the point is
      // the envelope + state mapping hold against live data.
      const polled = await runner.pollOnce("live-smoke:single");
      expect(["GENERATING", "GENERATED_TEMPORARY", "REJECTED"]).toContain(polled.state);
    },
  );
});