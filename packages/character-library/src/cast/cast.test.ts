import { describe, expect, it } from "vitest";

import {
  CastService,
  InMemoryGlobalCharacterReader,
  InMemorySeriesCastStore,
  InvalidCastRangeError,
  InvalidCharacterIdError,
  NotInCastError,
  UnknownCharacterError,
  compareEpisodePoints,
  isCastableState,
  linkCoversEpisode,
} from "./index.js";
import type { GlobalCharacterRecord, SeriesCastLink } from "./index.js";

function monica(overrides: Partial<GlobalCharacterRecord> = {}): GlobalCharacterRecord {
  return {
    characterId: "CHAR_MONICA_BENNETT_001",
    displayName: "Monica Bennett",
    activeIdentityVersion: "v1",
    activeAppearanceVersion: "long-braids-v1",
    activeVoiceProfileId: "VOICE_MONICA_001",
    state: "CANONICAL",
    ...overrides,
  };
}

function harness(global: GlobalCharacterRecord[] = [monica()]) {
  const reader = new InMemoryGlobalCharacterReader(global);
  const store = new InMemorySeriesCastStore();
  let tick = 0;
  const service = new CastService({
    globalCharacters: reader,
    castStore: store,
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)),
  });
  return { reader, store, service };
}

describe("global library ↔ per-series cast join", () => {
  it("links a CANONICAL global character into a series cast", async () => {
    const { service } = harness();
    const link = await service.linkCharacter({
      seriesId: "SERIES_HARBOR_LIGHTS",
      characterId: "CHAR_MONICA_BENNETT_001",
    });
    expect(link.seriesId).toBe("SERIES_HARBOR_LIGHTS");
    expect(link.characterId).toBe("CHAR_MONICA_BENNETT_001");
    expect(link.status).toBe("series-regular");
    expect(link.effectiveFrom).toBeNull();
    expect(link.effectiveUntil).toBeNull();
    expect(link.linkedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("joins by permanent ID, never by display name", async () => {
    const { service } = harness();
    await expect(
      service.linkCharacter({
        seriesId: "S1",
        characterId: "Monica Bennett",
      }),
    ).rejects.toBeInstanceOf(UnknownCharacterError);
    await expect(
      service.linkCharacter({ seriesId: "S1", characterId: "monica bennett" }),
    ).rejects.toBeInstanceOf(UnknownCharacterError);
  });

  it("rejects unknown global character IDs", async () => {
    const { service } = harness();
    await expect(
      service.linkCharacter({ seriesId: "S1", characterId: "CHAR_NOBODY_001" }),
    ).rejects.toBeInstanceOf(UnknownCharacterError);
  });

  it("rejects linking DRAFT/REJECTED/RETIRED global characters", async () => {
    const { service } = harness([
      monica({ characterId: "CHAR_DRAFT_ONE_001", state: "DRAFT" }),
      monica({ characterId: "CHAR_REJ_ONE_001", state: "REJECTED" }),
      monica({ characterId: "CHAR_RET_ONE_001", state: "RETIRED" }),
    ]);
    for (const id of [
      "CHAR_DRAFT_ONE_001",
      "CHAR_REJ_ONE_001",
      "CHAR_RET_ONE_001",
    ]) {
      await expect(
        service.linkCharacter({ seriesId: "S1", characterId: id }),
      ).rejects.toThrow(/only APPROVED or CANONICAL/);
    }
  });

  it("allows APPROVED and CANONICAL states only", () => {
    expect(isCastableState("APPROVED")).toBe(true);
    expect(isCastableState("CANONICAL")).toBe(true);
    expect(isCastableState("DRAFT")).toBe(false);
    expect(isCastableState("REVIEW")).toBe(false);
    expect(isCastableState("RETIRED")).toBe(false);
    expect(isCastableState("REJECTED")).toBe(false);
  });

  it("lists the full cast of a series", async () => {
    const { service } = harness([
      monica(),
      monica({
        characterId: "CHAR_MARCUS_HALE_001",
        displayName: "Marcus Hale",
      }),
    ]);
    await service.linkCharacter({
      seriesId: "S1",
      characterId: "CHAR_MONICA_BENNETT_001",
    });
    await service.linkCharacter({
      seriesId: "S1",
      characterId: "CHAR_MARCUS_HALE_001",
      status: "recurring",
    });
    await service.linkCharacter({
      seriesId: "OTHER",
      characterId: "CHAR_MONICA_BENNETT_001",
    });
    const cast = await service.listCast("S1");
    expect(cast.map((l) => l.characterId).sort()).toEqual([
      "CHAR_MARCUS_HALE_001",
      "CHAR_MONICA_BENNETT_001",
    ]);
  });
});

describe("cast resolution by episode", () => {
  it("resolves open-ended links at any episode", async () => {
    const { service } = harness();
    await service.linkCharacter({
      seriesId: "S1",
      characterId: "CHAR_MONICA_BENNETT_001",
    });
    for (const point of [
      { season: 1, episode: 1 },
      { season: 1, episode: 8 },
      { season: 5, episode: 12 },
    ]) {
      const cast = await service.resolveCastForEpisode("S1", point);
      expect(cast).toHaveLength(1);
      expect(cast[0]?.characterId).toBe("CHAR_MONICA_BENNETT_001");
    }
  });

  it("resolves links only within their effective range (until exclusive)", async () => {
    const { service } = harness();
    await service.linkCharacter({
      seriesId: "S1",
      characterId: "CHAR_MONICA_BENNETT_001",
      effectiveFrom: { season: 1, episode: 3 },
      effectiveUntil: { season: 1, episode: 9 },
    });
    const before = await service.resolveCastForEpisode("S1", {
      season: 1,
      episode: 2,
    });
    expect(before).toHaveLength(0);
    const during = await service.resolveCastForEpisode("S1", {
      season: 1,
      episode: 3,
    });
    expect(during).toHaveLength(1);
    const last = await service.resolveCastForEpisode("S1", {
      season: 1,
      episode: 8,
    });
    expect(last).toHaveLength(1);
    const after = await service.resolveCastForEpisode("S1", {
      season: 1,
      episode: 9,
    });
    expect(after).toHaveLength(0);
  });

  it("falls back to global active appearance/voice when no series override", async () => {
    const { service } = harness();
    await service.linkCharacter({
      seriesId: "S1",
      characterId: "CHAR_MONICA_BENNETT_001",
    });
    const [member] = await service.resolveCastForEpisode("S1", {
      season: 1,
      episode: 1,
    });
    expect(member?.appearanceVersion).toBe("long-braids-v1");
    expect(member?.voiceProfileId).toBe("VOICE_MONICA_001");
  });

  it("series overrides win over global active versions", async () => {
    const { service } = harness();
    await service.linkCharacter({
      seriesId: "S1",
      characterId: "CHAR_MONICA_BENNETT_001",
      appearanceVersion: "business-blue-v1",
      voiceProfileId: "VOICE_MONICA_S1_ALT",
    });
    const [member] = await service.resolveCastForEpisode("S1", {
      season: 1,
      episode: 1,
    });
    expect(member?.appearanceVersion).toBe("business-blue-v1");
    expect(member?.voiceProfileId).toBe("VOICE_MONICA_S1_ALT");
  });

  it("resolution reflects canon-at-time global state at call time", async () => {
    // spec.md §9: historical episodes keep referencing the canon-at-the-time
    // version. Resolution joins live, so a global identity change made after
    // linking is observed at resolve time — never copied at link time.
    const { reader, service } = harness();
    await service.linkCharacter({
      seriesId: "S1",
      characterId: "CHAR_MONICA_BENNETT_001",
    });
    reader.seed(monica({ activeIdentityVersion: "v2", activeAppearanceVersion: "short-hair-v2" }));
    const [member] = await service.resolveCastForEpisode("S1", {
      season: 1,
      episode: 1,
    });
    expect(member?.globalCharacter.activeIdentityVersion).toBe("v2");
  });

  it("skips links whose global record no longer resolves", async () => {
    // Simulate a store row whose global character was removed outside this
    // module (e.g. direct DB surgery): the empty reader cannot resolve it.
    const store = new InMemorySeriesCastStore();
    const emptyReader = new InMemoryGlobalCharacterReader();
    const service2 = new CastService({
      globalCharacters: emptyReader,
      castStore: store,
    });
    await store.add({
      seriesId: "S1",
      characterId: "CHAR_MONICA_BENNETT_001",
      status: "series-regular",
      effectiveFrom: null,
      effectiveUntil: null,
      appearanceVersion: null,
      voiceProfileId: null,
      linkedAt: "2026-01-01T00:00:00.000Z",
    });
    const cast = await service2.resolveCastForEpisode("S1", {
      season: 1,
      episode: 1,
    });
    expect(cast).toHaveLength(0);
  });

  it("resolveMember returns null when not covering the episode", async () => {
    const { service } = harness();
    await service.linkCharacter({
      seriesId: "S1",
      characterId: "CHAR_MONICA_BENNETT_001",
      effectiveFrom: { season: 2, episode: 1 },
    });
    expect(
      await service.resolveMember("S1", "CHAR_MONICA_BENNETT_001", {
        season: 1,
        episode: 5,
      }),
    ).toBeNull();
    expect(
      await service.resolveMember("S1", "CHAR_MONICA_BENNETT_001", {
        season: 2,
        episode: 1,
      }),
    ).not.toBeNull();
  });
});

describe("removing series cast never deletes global character", () => {
  it("unlink removes the link but the global character remains", async () => {
    const { service } = harness();
    await service.linkCharacter({
      seriesId: "S1",
      characterId: "CHAR_MONICA_BENNETT_001",
    });
    await service.unlinkCharacter("S1", "CHAR_MONICA_BENNETT_001");
    const cast = await service.listCast("S1");
    expect(cast).toHaveLength(0);
    const global = await service.getGlobalRecord("CHAR_MONICA_BENNETT_001");
    expect(global).not.toBeNull();
    expect(global?.displayName).toBe("Monica Bennett");
    expect(global?.state).toBe("CANONICAL");
  });

  it("unlinked characters can be re-linked and resolve again", async () => {
    const { service } = harness();
    await service.linkCharacter({
      seriesId: "S1",
      characterId: "CHAR_MONICA_BENNETT_001",
    });
    await service.unlinkCharacter("S1", "CHAR_MONICA_BENNETT_001");
    await service.linkCharacter({
      seriesId: "S1",
      characterId: "CHAR_MONICA_BENNETT_001",
      appearanceVersion: "business-blue-v1",
    });
    const [member] = await service.resolveCastForEpisode("S1", {
      season: 1,
      episode: 1,
    });
    expect(member?.appearanceVersion).toBe("business-blue-v1");
  });

  it("removing the cast link leaves the character castable in other series", async () => {
    const { service } = harness();
    await service.linkCharacter({ seriesId: "S1", characterId: "CHAR_MONICA_BENNETT_001" });
    await service.linkCharacter({ seriesId: "S2", characterId: "CHAR_MONICA_BENNETT_001" });
    await service.unlinkCharacter("S1", "CHAR_MONICA_BENNETT_001");
    const s2 = await service.resolveCastForEpisode("S2", { season: 1, episode: 1 });
    expect(s2).toHaveLength(1);
    const s1 = await service.resolveCastForEpisode("S1", { season: 1, episode: 1 });
    expect(s1).toHaveLength(0);
    const global = await service.getGlobalRecord("CHAR_MONICA_BENNETT_001");
    expect(global).not.toBeNull();
  });

  it("unlinking a non-member throws and deletes nothing", async () => {
    const { service } = harness();
    await expect(
      service.unlinkCharacter("S1", "CHAR_MONICA_BENNETT_001"),
    ).rejects.toBeInstanceOf(NotInCastError);
    const global = await service.getGlobalRecord("CHAR_MONICA_BENNETT_001");
    expect(global).not.toBeNull();
  });

  it("endCastAt keeps the link and the global character, stops future episodes", async () => {
    const { service } = harness();
    await service.linkCharacter({
      seriesId: "S1",
      characterId: "CHAR_MONICA_BENNETT_001",
    });
    await service.endCastAt("S1", "CHAR_MONICA_BENNETT_001", {
      season: 1,
      episode: 8,
    });
    const during = await service.resolveCastForEpisode("S1", {
      season: 1,
      episode: 7,
    });
    expect(during).toHaveLength(1);
    const after = await service.resolveCastForEpisode("S1", {
      season: 1,
      episode: 8,
    });
    expect(after).toHaveLength(0);
    const links = await service.listCast("S1");
    expect(links).toHaveLength(1); // history kept
    const global = await service.getGlobalRecord("CHAR_MONICA_BENNETT_001");
    expect(global).not.toBeNull();
  });
});

describe("link integrity validation", () => {
  it("rejects display-name-keyed IDs at link time", async () => {
    const { service } = harness();
    // bypass UnknownCharacterError by using an existing record keyed wrong:
    // the validator fires before the unknown check for well-formed stores,
    // so use a seeded record with a bad ID.
    const reader = new InMemoryGlobalCharacterReader([
      monica({ characterId: "Monica Bennett" as never }),
    ]);
    const service2 = new CastService({
      globalCharacters: reader,
      castStore: new InMemorySeriesCastStore(),
    });
    await expect(
      service2.linkCharacter({
        seriesId: "S1",
        characterId: "Monica Bennett" as never,
      }),
    ).rejects.toBeInstanceOf(InvalidCharacterIdError);
    void service;
  });

  it("rejects inverted effective ranges", async () => {
    const { service } = harness();
    await expect(
      service.linkCharacter({
        seriesId: "S1",
        characterId: "CHAR_MONICA_BENNETT_001",
        effectiveFrom: { season: 2, episode: 1 },
        effectiveUntil: { season: 1, episode: 5 },
      }),
    ).rejects.toBeInstanceOf(InvalidCastRangeError);
    await expect(
      service.linkCharacter({
        seriesId: "S1",
        characterId: "CHAR_MONICA_BENNETT_001",
        effectiveFrom: { season: 1, episode: 5 },
        effectiveUntil: { season: 1, episode: 5 },
      }),
    ).rejects.toBeInstanceOf(InvalidCastRangeError);
  });

  it("updateCastLink revalidates the merged link", async () => {
    const { service } = harness();
    await service.linkCharacter({
      seriesId: "S1",
      characterId: "CHAR_MONICA_BENNETT_001",
    });
    await service.updateCastLink("S1", "CHAR_MONICA_BENNETT_001", {
      status: "guest",
    });
    const links = await service.listCast("S1");
    expect(links[0]?.status).toBe("guest");
    await expect(
      service.updateCastLink("S1", "CHAR_MONICA_BENNETT_001", {
        effectiveFrom: { season: 3, episode: 1 },
        effectiveUntil: { season: 2, episode: 1 },
      }),
    ).rejects.toBeInstanceOf(InvalidCastRangeError);
  });

  it("updateCastLink throws for non-members", async () => {
    const { service } = harness();
    await expect(
      service.updateCastLink("S1", "CHAR_MONICA_BENNETT_001", {
        status: "guest",
      }),
    ).rejects.toBeInstanceOf(NotInCastError);
  });
});

describe("pure range helpers", () => {
  const base: Omit<SeriesCastLink, "seriesId" | "characterId" | "linkedAt"> = {
    status: "series-regular",
    effectiveFrom: null,
    effectiveUntil: null,
    appearanceVersion: null,
    voiceProfileId: null,
  };

  function link(
    overrides: Partial<SeriesCastLink> = {},
  ): SeriesCastLink {
    return {
      seriesId: "S1",
      characterId: "CHAR_MONICA_BENNETT_001",
      linkedAt: "2026-01-01T00:00:00.000Z",
      ...base,
      ...overrides,
    };
  }

  it("compareEpisodePoints orders season then episode", () => {
    expect(compareEpisodePoints({ season: 1, episode: 9 }, { season: 2, episode: 1 })).toBe(-1);
    expect(compareEpisodePoints({ season: 2, episode: 1 }, { season: 1, episode: 9 })).toBe(1);
    expect(compareEpisodePoints({ season: 1, episode: 3 }, { season: 1, episode: 3 })).toBe(0);
  });

  it("linkCoversEpisode honors open and bounded ranges", () => {
    expect(
      linkCoversEpisode(link(), { season: 9, episode: 9 }),
    ).toBe(true);
    expect(
      linkCoversEpisode(
        link({ effectiveFrom: { season: 1, episode: 2 } }),
        { season: 1, episode: 1 },
      ),
    ).toBe(false);
    expect(
      linkCoversEpisode(
        link({ effectiveFrom: { season: 1, episode: 2 } }),
        { season: 1, episode: 2 },
      ),
    ).toBe(true);
    expect(
      linkCoversEpisode(
        link({ effectiveUntil: { season: 1, episode: 9 } }),
        { season: 1, episode: 9 },
      ),
    ).toBe(false);
    expect(
      linkCoversEpisode(
        link({ effectiveUntil: { season: 1, episode: 9 } }),
        { season: 1, episode: 8 },
      ),
    ).toBe(true);
  });
});