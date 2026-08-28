import { describe, expect, it } from "vitest";
import { FishDialogueCache } from "./cache.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FishDialogueRequest } from "./types.js";

describe("real-fs smoke", () => {
  it("persists and reopens through the default fs seam", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "fish005-"));
    try {
      const req: FishDialogueRequest = { text: "Smoke line.", voiceId: "v-smoke", model: "s2-pro", format: "mp3" };
      let synthCalls = 0;
      const synth = async (r: FishDialogueRequest) => {
        synthCalls++;
        return { audio: new TextEncoder().encode("smoke-audio").buffer as ArrayBuffer, model: r.model };
      };
      const cache = new FishDialogueCache({ directory: dir });
      const a = await cache.getOrSynthesize(req, synth);
      const b = await cache.getOrSynthesize(req, synth);
      expect(synthCalls).toBe(1);
      expect(a.key).toBe(b.key);
      const reopened = new FishDialogueCache({ directory: dir });
      const c = await reopened.get(req);
      expect(c?.key).toBe(a.key);
      expect(c && new TextDecoder().decode(c.audio)).toBe("smoke-audio");
      const keys = await reopened.keys();
      expect(keys).toEqual([a.key]);
      expect(await reopened.delete(a.key)).toBe(true);
      expect(await reopened.keys()).toEqual([]);
      expect(await reopened.get(req)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
