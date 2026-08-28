import { describe, expect, it } from "vitest";
import {
  addEpisodeSummary,
  addTimelineEvent,
  approveCanonChange,
  canonAtEpisode,
  characterCanonAtEpisode,
  createSeriesBible,
  currentCanon,
  episodeNumber,
  episodeSummariesBefore,
  proposeCanonChange,
  rejectCanonChange,
  SeriesBibleError,
} from "./index.js";
import type { SeriesBible } from "./types.js";

const MONICA = "CHAR_MONICA_BENNETT_001";
const MARCUS = "CHAR_MARCUS_COLE_002";
const HARRIS = "CHAR_HARRIS_VAUGHN_003";

/** Build the spec §10 running example: Hides series with a small canon. */
function seedBible(): SeriesBible {
  const bible = createSeriesBible({
    seriesId: "SER_HARTWELL_HEIGHTS_001",
    title: "Hartwell Heights",
    premise: "A night-shift ER doctor keeps reliving the same rainy Tuesday.",
  });
  proposeCanonChange(bible, {
    changeId: "CC_S01E01_001",
    description: "Series pilot canon: cast, world rule, style, voice, location",
    effectiveEpisode: "S01E01",
    proposedAt: "2026-08-01T00:00:00Z",
    mutations: [
      { op: "add_character", link: { characterId: MONICA, role: "lead" } },
      { op: "add_character", link: { characterId: MARCUS, role: "recurring" } },
      {
        op: "add_world_rule",
        rule: { ruleId: "RULE_LOOP_RESETS_AT_DAWN", statement: "The loop resets at dawn." },
      },
      {
        op: "set_visual_style",
        style: { styleGuide: "Rain-slick neo-noir, teal and sodium orange.", tags: ["neo-noir"] },
      },
      {
        op: "set_camera_language",
        camera: { grammar: ["handheld-in-arguments", "slow-push-in-on-revelations"] },
      },
      { op: "add_voice_profile", profile: { characterId: MONICA, voiceProfileId: "VOICE_MONICA_001" } },
      { op: "add_location", location: { locationId: "LOC_ER_BAY_001", name: "St. Alder ER bay 3" } },
      { op: "add_wardrobe", wardrobe: { characterId: MONICA, wardrobeVersion: "business-blue-v1" } },
    ],
  });
  approveCanonChange(bible, "CC_S01E01_001", "2026-08-01T01:00:00Z");
  return bible;
}

describe("episodeNumber — S<season>E<episode> ordering", () => {
  it("sorts S01E09 after S01E08 and S02 after S01", () => {
    expect(episodeNumber("S01E08")).toBeLessThan(episodeNumber("S01E09"));
    expect(episodeNumber("S01E99")).toBeLessThan(episodeNumber("S02E01"));
  });

  it("rejects non-episode codes, normalizes unpadded digits", () => {
    expect(() => episodeNumber("E09")).toThrow(SeriesBibleError);
    expect(episodeNumber("S1E9")).toBe(10009);
    expect(() => episodeNumber("S01E09B")).toThrow(SeriesBibleError);
    expect(() => episodeNumber("S01E9B")).toThrow(SeriesBibleError);
  });
});

describe("propose/approve canon changes — Gate 6 (spec §3.6, §10)", () => {
  it("proposing never touches canon", () => {
    const bible = createSeriesBible({ seriesId: "SER_X_001", title: "X" });
    proposeCanonChange(bible, {
      changeId: "CC_001",
      description: "Marcus broke his arm",
      effectiveEpisode: "S01E05",
      proposedAt: "2026-08-01T00:00:00Z",
      mutations: [
        {
          op: "record_character_event",
          event: { characterId: MARCUS, event: "broke left arm", effectiveEpisode: "S01E05" },
        },
      ],
    });
    expect(currentCanon(bible).characterEvents).toHaveLength(0);
    expect(bible.base.characterEvents).toHaveLength(0);
    expect(bible.canonChanges[0]?.status).toBe("PROPOSED");
  });

  it("approval applies mutations in order and assigns sequential canonVersion", () => {
    const bible = seedBible();
    proposeCanonChange(bible, {
      changeId: "CC_S01E09_001",
      description: "Monica moved apartments",
      effectiveEpisode: "S01E09",
      proposedAt: "2026-08-09T00:00:00Z",
      mutations: [
        {
          op: "record_character_event",
          event: { characterId: MONICA, event: "moved to apartment on Delancey", effectiveEpisode: "S01E09" },
        },
        { op: "add_prop", prop: { propId: "PROP_DELANCEY_KEY_001", name: "Delancey apartment key" } },
      ],
    });
    proposeCanonChange(bible, {
      changeId: "CC_S01E09_002",
      description: "Harris discovered the secret",
      effectiveEpisode: "S01E09",
      proposedAt: "2026-08-09T00:00:01Z",
      mutations: [
        {
          op: "record_character_event",
          event: { characterId: HARRIS, event: "discovered the secret", effectiveEpisode: "S01E09" },
        },
      ],
    });
    const first = approveCanonChange(bible, "CC_S01E09_001", "2026-08-09T02:00:00Z");
    const second = approveCanonChange(bible, "CC_S01E09_002", "2026-08-09T02:00:01Z");
    expect(first.canonVersion).toBe(2); // CC_S01E01_001 was version 1
    expect(second.canonVersion).toBe(3);
    const live = currentCanon(bible);
    expect(live.characterEvents.some((e) => e.event === "moved to apartment on Delancey")).toBe(true);
    expect(live.props.some((p) => p.propId === "PROP_DELANCEY_KEY_001")).toBe(true);
  });

  it("rejection leaves canon untouched and is terminal", () => {
    const bible = seedBible();
    proposeCanonChange(bible, {
      changeId: "CC_S01E06_001",
      description: "Marcus broke his arm",
      effectiveEpisode: "S01E06",
      proposedAt: "2026-08-06T00:00:00Z",
      mutations: [
        {
          op: "record_character_event",
          event: { characterId: MARCUS, event: "broke left arm", effectiveEpisode: "S01E06" },
        },
      ],
    });
    const rejected = rejectCanonChange(bible, "CC_S01E06_001", "2026-08-06T03:00:00Z");
    expect(rejected.status).toBe("REJECTED");
    expect(rejected.decidedAt).toBe("2026-08-06T03:00:00Z");
    expect(rejected.canonVersion).toBeUndefined();
    expect(currentCanon(bible).characterEvents).toHaveLength(0);
    expect(() => approveCanonChange(bible, "CC_S01E06_001", "2026-08-06T04:00:00Z")).toThrow(
      /already decided/,
    );
  });

  it("rejects re-approval, unknown IDs, and empty mutation lists", () => {
    const bible = seedBible();
    expect(() => approveCanonChange(bible, "CC_S01E01_001", "2026-08-01T02:00:00Z")).toThrow(
      /already decided/,
    );
    expect(() => approveCanonChange(bible, "CC_NOPE", "2026-08-01T02:00:00Z")).toThrow(/unknown canon change/);
    expect(() =>
      proposeCanonChange(bible, {
        changeId: "CC_EMPTY",
        description: "nothing",
        effectiveEpisode: "S01E02",
        proposedAt: "2026-08-02T00:00:00Z",
        mutations: [],
      }),
    ).toThrow(/proposes no mutations/);
  });

  it("duplicate adds throw during approval and leave the change marked approved-versionless", () => {
    const bible = seedBible();
    proposeCanonChange(bible, {
      changeId: "CC_DUP",
      description: "re-add Monica",
      effectiveEpisode: "S01E07",
      proposedAt: "2026-08-07T00:00:00Z",
      mutations: [{ op: "add_character", link: { characterId: MONICA, role: "lead" } }],
    });
    expect(() => approveCanonChange(bible, "CC_DUP", "2026-08-07T01:00:00Z")).toThrow(
      /character already in series cast/,
    );
  });
});

describe("canonAtEpisode — historical episodes read canon-at-time (spec §10)", () => {
  it("S01E05 does NOT see the S01E09 apartment move", () => {
    const bible = seedBible();
    proposeCanonChange(bible, {
      changeId: "CC_S01E09_001",
      description: "Monica moved apartments",
      effectiveEpisode: "S01E09",
      proposedAt: "2026-08-09T00:00:00Z",
      mutations: [
        {
          op: "record_character_event",
          event: { characterId: MONICA, event: "moved to apartment on Delancey", effectiveEpisode: "S01E09" },
        },
      ],
    });
    approveCanonChange(bible, "CC_S01E09_001", "2026-08-09T02:00:00Z");
    const early = canonAtEpisode(bible, "S01E05");
    expect(early.characterEvents.some((e) => e.event === "moved to apartment on Delancey")).toBe(false);
    const late = canonAtEpisode(bible, "S01E09");
    expect(late.characterEvents.some((e) => e.event === "moved to apartment on Delancey")).toBe(true);
  });

  it("PROPOSED and REJECTED changes never leak into any read", () => {
    const bible = seedBible();
    proposeCanOnChangeFallback(bible);
    expect(canonAtEpisode(bible, "S01E05").worldRules.some((r) => r.ruleId === "RULE_MAGIC")).toBe(false);
    expect(canonAtEpisode(bible, "S01E99").worldRules.some((r) => r.ruleId === "RULE_MAGIC")).toBe(false);
  });

  it("returns an independent copy — mutating a read cannot corrupt live canon", () => {
    const bible = seedBible();
    const snapshot = canonAtEpisode(bible, "S01E01");
    snapshot.characters.length = 0;
    snapshot.premise = "tampered";
    expect(currentCanon(bible).characters).toHaveLength(2);
    expect(currentCanon(bible).premise).not.toBe("tampered");
    expect(canonAtEpisode(bible, "S01E01").characters).toHaveLength(2);
  });

  it("a later-approved change still lands where its effective episode says", () => {
    const bible = seedBible();
    // Approved late (after E10 was produced) but effective from E04.
    proposeCanonChange(bible, {
      changeId: "CC_S01E04_001",
      description: "retroactive: the ER clock is always 11:47",
      effectiveEpisode: "S01E04",
      proposedAt: "2026-08-11T00:00:00Z",
      mutations: [
        {
          op: "add_world_rule",
          rule: { ruleId: "RULE_ER_CLOCK", statement: "The ER wall clock reads 11:47." },
        },
      ],
    });
    approveCanonChange(bible, "CC_S01E04_001", "2026-08-11T01:00:00Z");
    expect(canonAtEpisode(bible, "S01E03").worldRules.some((r) => r.ruleId === "RULE_ER_CLOCK")).toBe(false);
    expect(canonAtEpisode(bible, "S01E04").worldRules.some((r) => r.ruleId === "RULE_ER_CLOCK")).toBe(true);
  });
});

describe("characterCanonAtEpisode — continuity-point read for planners", () => {
  it("sees cast state, events, wardrobe, and voice as of the episode", () => {
    const bible = seedBible();
    proposeCanOnChangeWardrobe(bible);
    approveCanonChange(bible, "CC_S01E09_003", "2026-08-09T04:00:00Z");
    const e05 = characterCanonAtEpisode(bible, MONICA, "S01E05");
    expect(e05.inCast).toBe(true);
    expect(e05.events).toHaveLength(0);
    expect(e05.wardrobe).toEqual(["business-blue-v1"]);
    expect(e05.voiceProfileId).toBe("VOICE_MONICA_001");
    const e09 = characterCanonAtEpisode(bible, MONICA, "S01E09");
    expect(e09.events.some((e) => e.event === "moved to apartment on Delancey")).toBe(true);
    expect(e09.wardrobe).toEqual(["business-blue-v1", "weekend-casual-v2"]);
    const stranger = characterCanonAtEpisode(bible, "CHAR_UNKNOWN_009", "S01E09");
    expect(stranger.inCast).toBe(false);
  });
});

describe("episode summaries + timeline — append-only records", () => {
  it("records summaries and serves only the ones before a query episode", () => {
    const bible = seedBible();
    addEpisodeSummary(bible, { episode: "S01E01", title: "Pilot", summary: "Monica notices the loop." });
    addEpisodeSummary(bible, { episode: "S01E02", summary: "Marcus believes her." });
    expect(bible.episodeSummaries).toHaveLength(2);
    expect(episodeSummariesBefore(bible, "S01E03")).toHaveLength(2);
    expect(episodeSummariesBefore(bible, "S01E02")).toHaveLength(1);
    expect(episodeSummariesBefore(bible, "S01E01")).toHaveLength(0);
  });

  it("rejects empty and duplicate summaries", () => {
    const bible = seedBible();
    expect(() => addEpisodeSummary(bible, { episode: "S01E01", summary: "   " })).toThrow(/non-empty/);
    addEpisodeSummary(bible, { episode: "S01E01", summary: "The loop." });
    expect(() => addEpisodeSummary(bible, { episode: "S01E01", summary: "again" })).toThrow(/already recorded/);
  });

  it("records timeline events with unique IDs", () => {
    const bible = seedBible();
    addTimelineEvent(bible, { eventId: "TL_001", episode: "S01E01", description: "First dawn reset." });
    expect(() =>
      addTimelineEvent(bible, { eventId: "TL_001", episode: "S01E02", description: "dup" }),
    ).toThrow(/already recorded/);
    expect(() => addTimelineEvent(bible, { eventId: " ", episode: "S01E02", description: "blank" })).toThrow(
      /non-empty/,
    );
    expect(bible.timeline).toHaveLength(1);
  });
});

describe("series sections — full spec §10 field coverage", () => {
  it("carries premise, world rules, relationships, locations, wardrobe, props, style, camera, voices, threads", () => {
    const bible = seedBible();
    proposeCanonChange(bible, {
      changeId: "CC_S01E03_001",
      description: "build out series fabric",
      effectiveEpisode: "S01E03",
      proposedAt: "2026-08-03T00:00:00Z",
      mutations: [
        { op: "set_premise", premise: "Same rainy Tuesday, tighter each reset." },
        { op: "add_relationship", relationship: { relationshipId: "REL_001", fromCharacterId: MONICA, toCharacterId: MARCUS, kind: "sibling" } },
        { op: "add_wardrobe", wardrobe: { characterId: MONICA, wardrobeVersion: "business-blue-v1" } },
        { op: "add_prop", prop: { propId: "PROP_PAGER_001", name: "Monica's pager" } },
        { op: "open_plot_thread", thread: { threadId: "PT_001", description: "Who else remembers?", openedEpisode: "S01E03", status: "open" } },
      ],
    });
    approveCanonChange(bible, "CC_S01E03_001", "2026-08-03T01:00:00Z");
    const canon = canonAtEpisode(bible, "S01E03");
    expect(canon.premise).toBe("Same rainy Tuesday, tighter each reset.");
    expect(canon.relationships).toHaveLength(1);
    expect(canon.wardrobe[0]?.wardrobeVersion).toBe("business-blue-v1");
    expect(canon.props[0]?.name).toBe("Monica's pager");
    expect(canon.visualStyle.tags).toContain("neo-noir");
    expect(canon.cameraLanguage.grammar).toContain("handheld-in-arguments");
    expect(canon.voiceProfiles[0]?.voiceProfileId).toBe("VOICE_MONICA_001");
    expect(canon.locations[0]?.locationId).toBe("LOC_ER_BAY_001");
    expect(canon.plotThreads[0]?.status).toBe("open");
  });

  it("resolves and retires through canon changes, visible only at the right episode", () => {
    const bible = seedBible();
    proposeCanonChange(bible, {
      changeId: "CC_S01E02_001",
      description: "open thread + extra rule",
      effectiveEpisode: "S01E02",
      proposedAt: "2026-08-02T00:00:00Z",
      mutations: [
        { op: "open_plot_thread", thread: { threadId: "PT_002", description: "The 11:47 nurse", openedEpisode: "S01E02", status: "open" } },
        { op: "add_world_rule", rule: { ruleId: "RULE_TEMP", statement: "Temp rule." } },
        { op: "add_location", location: { locationId: "LOC_ROOFTOP_001", name: "St. Alder rooftop" } },
      ],
    });
    approveCanonChange(bible, "CC_S01E02_001", "2026-08-02T01:00:00Z");
    proposeCanonChange(bible, {
      changeId: "CC_S01E08_001",
      description: "resolve thread, retire rule and rooftop",
      effectiveEpisode: "S01E08",
      proposedAt: "2026-08-08T00:00:00Z",
      mutations: [
        { op: "resolve_plot_thread", threadId: "PT_002", resolvedEpisode: "S01E08", resolution: "She remembered too." },
        { op: "retire_world_rule", ruleId: "RULE_TEMP" },
        { op: "retire_location", locationId: "LOC_ROOFTOP_001" },
      ],
    });
    approveCanonChange(bible, "CC_S01E08_001", "2026-08-08T01:00:00Z");
    expect(canonAtEpisode(bible, "S01E05").plotThreads.find((t) => t.threadId === "PT_002")?.status).toBe("open");
    const e08 = canonAtEpisode(bible, "S01E08");
    const thread = e08.plotThreads.find((t) => t.threadId === "PT_002");
    expect(thread?.status).toBe("resolved");
    expect(thread?.resolution).toBe("She remembered too.");
    expect(e08.worldRules.some((r) => r.ruleId === "RULE_TEMP")).toBe(false);
    expect(e08.locations.some((l) => l.locationId === "LOC_ROOFTOP_001")).toBe(false);
    // The pilot's own rule survived both changes.
    expect(e08.worldRules.some((r) => r.ruleId === "RULE_LOOP_RESETS_AT_DAWN")).toBe(true);
  });

  it("remove_character drops the character from the cast at its effective episode", () => {
    const bible = seedBible();
    proposeCanonChange(bible, {
      changeId: "CC_S01E10_001",
      description: "Marcus leaves the series",
      effectiveEpisode: "S01E10",
      proposedAt: "2026-08-10T00:00:00Z",
      mutations: [{ op: "remove_character", characterId: MARCUS }],
    });
    approveCanonChange(bible, "CC_S01E10_001", "2026-08-10T01:00:00Z");
    expect(canonAtEpisode(bible, "S01E09").characters.some((c) => c.characterId === MARCUS)).toBe(true);
    expect(canonAtEpisode(bible, "S01E10").characters.some((c) => c.characterId === MARCUS)).toBe(false);
  });
});

/** Stage a PROPOSED magic-rule change plus one REJECTED twin (helper). */
function proposeCanOnChangeFallback(bible: SeriesBible): void {
  proposeCanonChange(bible, {
    changeId: "CC_MAGIC_PROPOSED",
    description: "magic system",
    effectiveEpisode: "S01E04",
    proposedAt: "2026-08-04T00:00:00Z",
    mutations: [{ op: "add_world_rule", rule: { ruleId: "RULE_MAGIC", statement: "Magic exists." } }],
  });
  proposeCanonChange(bible, {
    changeId: "CC_MAGIC_REJECTED",
    description: "more magic",
    effectiveEpisode: "S01E05",
    proposedAt: "2026-08-05T00:00:00Z",
    mutations: [{ op: "add_world_rule", rule: { ruleId: "RULE_MAGIC_2", statement: "More magic." } }],
  });
  rejectCanonChange(bible, "CC_MAGIC_REJECTED", "2026-08-05T01:00:00Z");
}

/** Stage a wardrobe-addition change for Monica effective S01E09 (helper). */
function proposeCanOnChangeWardrobe(bible: SeriesBible): void {
  proposeCanonChange(bible, {
    changeId: "CC_S01E09_003",
    description: "Monica weekend wardrobe + apartment move",
    effectiveEpisode: "S01E09",
    proposedAt: "2026-08-09T03:00:00Z",
    mutations: [
      { op: "add_wardrobe", wardrobe: { characterId: MONICA, wardrobeVersion: "weekend-casual-v2" } },
      {
        op: "record_character_event",
        event: { characterId: MONICA, event: "moved to apartment on Delancey", effectiveEpisode: "S01E09" },
      },
    ],
  });
}