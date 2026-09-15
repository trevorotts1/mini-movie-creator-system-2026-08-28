import { describe, expect, it } from "vitest";
import {
  GhlTokenLocationMismatchError,
  verifyTokenLocation,
  type TokenLocationFetch,
} from "./token-location.js";

/** A fetch double that records the URL it was asked for. */
function fakeFetch(
  status: number,
  body: unknown = {},
  onCall?: (url: string) => void,
): { fetchImpl: TokenLocationFetch; urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    fetchImpl: async (url) => {
      urls.push(url);
      onCall?.(url);
      return { status, json: async () => body };
    },
  };
}

const BASE = {
  baseUrl: "https://services.leadconnectorhq.com",
  locationId: "loc_client_a",
  headers: { Authorization: "Bearer per-deployment-token", Version: "2021-07-28" },
};

describe("verifyTokenLocation", () => {
  it("resolves when the token can see the configured location", async () => {
    const { fetchImpl, urls } = fakeFetch(200, { location: { id: "loc_client_a", name: "Client A" } });
    const result = await verifyTokenLocation({ ...BASE, fetchImpl });
    expect(result.locationId).toBe("loc_client_a");
    expect(result.name).toBe("Client A");
    // Asks about THIS deployment's location, using its own headers.
    expect(urls[0]).toBe("https://services.leadconnectorhq.com/locations/loc_client_a");
  });

  it("tolerates a trailing slash on the base URL", async () => {
    const { fetchImpl, urls } = fakeFetch(200, {});
    await verifyTokenLocation({ ...BASE, baseUrl: "https://api.example.com/", fetchImpl });
    expect(urls[0]).toBe("https://api.example.com/locations/loc_client_a");
  });

  it("refuses when the token cannot access the location (401/403/404)", async () => {
    for (const status of [401, 403, 404]) {
      const { fetchImpl } = fakeFetch(status);
      await expect(verifyTokenLocation({ ...BASE, fetchImpl })).rejects.toBeInstanceOf(
        GhlTokenLocationMismatchError,
      );
    }
  });

  it("refuses on any unexpected status rather than assuming the pairing is fine", async () => {
    // A 500 is NOT verification. Treating an unverifiable pairing as verified
    // is how a misconfigured token reaches a write path.
    const { fetchImpl } = fakeFetch(500);
    await expect(verifyTokenLocation({ ...BASE, fetchImpl })).rejects.toBeInstanceOf(
      GhlTokenLocationMismatchError,
    );
  });

  it("names both the location and the status, because the fix is a config change", async () => {
    const { fetchImpl } = fakeFetch(403);
    await expect(verifyTokenLocation({ ...BASE, fetchImpl })).rejects.toThrow(
      /loc_client_a.*403|403.*loc_client_a/s,
    );
  });

  it("rejects a blank location id before making any request", async () => {
    const { fetchImpl, urls } = fakeFetch(200);
    await expect(
      verifyTokenLocation({ ...BASE, locationId: "   ", fetchImpl }),
    ).rejects.toBeInstanceOf(GhlTokenLocationMismatchError);
    expect(urls).toHaveLength(0);
  });

  it("succeeds without a name when GHL returns an unreadable body", async () => {
    // A 2xx means the token reached the location, which is the question asked;
    // a parse failure must not turn that into a false mismatch.
    const fetchImpl: TokenLocationFetch = async () => ({
      status: 200,
      json: async () => {
        throw new Error("not json");
      },
    });
    const result = await verifyTokenLocation({ ...BASE, fetchImpl });
    expect(result.locationId).toBe("loc_client_a");
    expect(result.name).toBeUndefined();
  });

  it("propagates a transport failure instead of reporting a mismatch", async () => {
    // "Could not check" and "checked and it failed" are different outcomes and
    // must not be collapsed.
    const fetchImpl: TokenLocationFetch = async () => {
      throw new Error("network down");
    };
    await expect(verifyTokenLocation({ ...BASE, fetchImpl })).rejects.toThrow(/network down/);
  });
});
