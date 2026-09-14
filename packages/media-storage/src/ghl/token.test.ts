/**
 * GHL token lifecycle tests (SKR-026). No network: refreshers are injected and
 * the clock is a fixed counter.
 */
import { describe, expect, it } from "vitest";
import {
  GhlTokenCache,
  GhlTokenRefreshError,
  GhlTokenRefreshUnsupportedError,
} from "./token.js";

const TOKEN = "initial-token-value-1234";

function fixedClock(startMs = Date.parse("2026-08-28T12:00:00.000Z")): {
  now: () => number;
  advance: (ms: number) => void;
} {
  let current = startMs;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

describe("GhlTokenCache", () => {
  it("reads back the stored token kind (the value that was never consumed)", () => {
    const pit = new GhlTokenCache({ token: TOKEN, kind: "private-integration-token" });
    const oauth = new GhlTokenCache({ token: TOKEN, kind: "sub-account-access-token" });
    expect(pit.kind).toBe("private-integration-token");
    expect(oauth.kind).toBe("sub-account-access-token");
    expect(pit.current()).toBe(TOKEN);
  });

  it("does not refresh an unexpired token", async () => {
    const clock = fixedClock();
    let refreshes = 0;
    const cache = new GhlTokenCache({
      token: TOKEN,
      kind: "sub-account-access-token",
      expiresAt: "2026-08-28T13:00:00.000Z", // an hour out
      refresh: async () => {
        refreshes += 1;
        return { token: "new" };
      },
      now: clock.now,
    });
    expect(cache.needsRefresh()).toBe(false);
    expect(await cache.getToken()).toBe(TOKEN);
    expect(refreshes).toBe(0);
  });

  it("refreshes inside the expiry skew window and adopts the new expiry", async () => {
    const clock = fixedClock();
    const cache = new GhlTokenCache({
      token: TOKEN,
      kind: "sub-account-access-token",
      expiresAt: "2026-08-28T12:00:30.000Z", // 30 s out, inside the 60 s skew
      refresh: async (current) => {
        expect(current.kind).toBe("sub-account-access-token");
        expect(current.token).toBe(TOKEN);
        return { token: "refreshed-token-value", expiresAt: "2026-08-29T12:00:00.000Z" };
      },
      now: clock.now,
    });
    expect(cache.needsRefresh()).toBe(true);
    expect(await cache.getToken()).toBe("refreshed-token-value");
    expect(cache.current()).toBe("refreshed-token-value");
    expect(cache.currentExpiresAt).toBe("2026-08-29T12:00:00.000Z");
    expect(cache.needsRefresh()).toBe(false);
  });

  it("shares ONE refresh between concurrent callers", async () => {
    const clock = fixedClock();
    let refreshes = 0;
    const cache = new GhlTokenCache({
      token: TOKEN,
      kind: "sub-account-access-token",
      expiresAt: "2026-08-28T11:59:00.000Z", // already expired
      refresh: async () => {
        refreshes += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { token: `refreshed-${refreshes}` };
      },
      now: clock.now,
    });
    const tokens = await Promise.all([cache.getToken(), cache.getToken(), cache.getToken()]);
    expect(refreshes).toBe(1);
    expect(tokens).toEqual(["refreshed-1", "refreshed-1", "refreshed-1"]);
  });

  it("recovers from a 401 by refreshing an OAuth token", async () => {
    const cache = new GhlTokenCache({
      token: TOKEN,
      kind: "sub-account-access-token",
      refresh: async () => ({ token: "after-401" }),
    });
    expect(await cache.recoverFromUnauthorized()).toBe("after-401");
    expect(cache.current()).toBe("after-401");
  });

  it("refuses to 'refresh' a static private integration token on 401", async () => {
    const cache = new GhlTokenCache({ token: TOKEN, kind: "private-integration-token" });
    await expect(cache.recoverFromUnauthorized()).rejects.toBeInstanceOf(
      GhlTokenRefreshUnsupportedError,
    );
    await expect(cache.recoverFromUnauthorized()).rejects.toThrow(/rotate GHL_ACCESS_TOKEN/);
  });

  it("refuses to refresh an OAuth token with no refresher wired", async () => {
    const cache = new GhlTokenCache({
      token: TOKEN,
      kind: "sub-account-access-token",
      expiresAt: "2026-08-28T11:59:00.000Z",
    });
    await expect(cache.getToken()).rejects.toBeInstanceOf(GhlTokenRefreshUnsupportedError);
    await expect(cache.recoverFromUnauthorized()).rejects.toBeInstanceOf(
      GhlTokenRefreshUnsupportedError,
    );
  });

  it("keeps the previous token and reports why when a refresh fails", async () => {
    const cache = new GhlTokenCache({
      token: TOKEN,
      kind: "sub-account-access-token",
      refresh: async () => {
        throw new Error("refresh endpoint returned 500");
      },
    });
    try {
      await cache.recoverFromUnauthorized();
      expect.unreachable("a failed refresh must throw");
    } catch (err) {
      expect(err).toBeInstanceOf(GhlTokenRefreshError);
      expect((err as GhlTokenRefreshError).message).toContain("500");
      // The old token survives: the next attempt can retry the refresh.
      expect(cache.current()).toBe(TOKEN);
    }
    // A refresh that resolves without a token is a failure too, not a blank cache.
    const empty = new GhlTokenCache({
      token: TOKEN,
      kind: "sub-account-access-token",
      refresh: async () => ({ token: "   " }),
    });
    await expect(empty.recoverFromUnauthorized()).rejects.toBeInstanceOf(GhlTokenRefreshError);
    expect(empty.current()).toBe(TOKEN);
  });

  it("treats an unknown expiry as 'not expiring' and leans on the 401 path", () => {
    const cache = new GhlTokenCache({ token: TOKEN, kind: "sub-account-access-token" });
    expect(cache.needsRefresh()).toBe(false);
    expect(cache.isExpired()).toBe(false);
  });
});
