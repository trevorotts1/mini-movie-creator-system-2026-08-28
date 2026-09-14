/**
 * GHL tenant guard tests (SKR-011). Pure functions, no network, no DB.
 */
import { describe, expect, it } from "vitest";
import {
  GHL_LOCATION_MISMATCH_CODE,
  GhlLocationMismatchError,
  MissingGhlLocationError,
  assertStoredLocationMatches,
  requireLocationId,
} from "./tenant.js";

describe("assertStoredLocationMatches", () => {
  it("returns the requested location when it matches the stored one", () => {
    expect(
      assertStoredLocationMatches({
        storedLocationId: "loc_A",
        requestedLocationId: "loc_A",
        subject: 'asset "a1"',
      }),
    ).toBe("loc_A");
  });

  it("falls back to whichever side is known", () => {
    expect(
      assertStoredLocationMatches({
        storedLocationId: "loc_A",
        requestedLocationId: undefined,
        subject: 'asset "a1"',
      }),
    ).toBe("loc_A");
    expect(
      assertStoredLocationMatches({
        storedLocationId: undefined,
        requestedLocationId: "loc_B",
        subject: 'asset "a1"',
      }),
    ).toBe("loc_B");
    expect(
      assertStoredLocationMatches({ subject: 'asset "a1"' }),
    ).toBeUndefined();
  });

  it("refuses a write under a different location, naming both tenants", () => {
    try {
      assertStoredLocationMatches({
        storedLocationId: "loc_A",
        requestedLocationId: "loc_B",
        subject: 'asset "a1"',
        action: "re-archive",
      });
      expect.unreachable("cross-tenant write must throw");
    } catch (err) {
      expect(err).toBeInstanceOf(GhlLocationMismatchError);
      const mismatch = err as GhlLocationMismatchError;
      expect(mismatch.code).toBe(GHL_LOCATION_MISMATCH_CODE);
      expect(mismatch.storedLocationId).toBe("loc_A");
      expect(mismatch.requestedLocationId).toBe("loc_B");
      expect(mismatch.message).toContain("refusing re-archive");
      expect(mismatch.message).toContain("tenant boundary");
    }
  });

  it("treats blank ids as absent and trims what it compares", () => {
    expect(
      assertStoredLocationMatches({
        storedLocationId: "  loc_A  ",
        requestedLocationId: "loc_A",
        subject: 'asset "a1"',
      }),
    ).toBe("loc_A");
    // A blank request must never be read as "no constraint" on a stored record.
    expect(
      assertStoredLocationMatches({
        storedLocationId: "loc_A",
        requestedLocationId: "   ",
        subject: 'asset "a1"',
      }),
    ).toBe("loc_A");
    expect(
      assertStoredLocationMatches({
        storedLocationId: "  ",
        requestedLocationId: undefined,
        subject: 'asset "a1"',
      }),
    ).toBeUndefined();
  });
});

describe("requireLocationId", () => {
  it("returns the trimmed id and rejects blank/undefined", () => {
    expect(requireLocationId(" loc_A ")).toBe("loc_A");
    expect(() => requireLocationId(undefined)).toThrow(MissingGhlLocationError);
    expect(() => requireLocationId("   ")).toThrow(/locationId/);
    try {
      requireLocationId(undefined, "altId");
    } catch (err) {
      expect((err as MissingGhlLocationError).field).toBe("altId");
    }
  });
});
