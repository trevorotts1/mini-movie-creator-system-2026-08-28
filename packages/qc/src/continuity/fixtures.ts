/**
 * Continuity fixtures (QC-004) — spec §11 "Scene continuity QC compares
 * neighboring shots against each other and the current Series Bible state."
 *
 * `breakScene` is the continuity-break fixture: three neighboring shots in
 * one scene where the third shot jumps location, time of day, wardrobe,
 * hair, drops a prop, mismatches the previous end state, and contradicts the
 * Series Bible canon-at-the-time (S01E05 resolves Monica appearance v1).
 *
 * `cleanScene` is the control: consistent neighbors plus a bible that
 * matches — must yield zero findings.
 */

import type {
  ContinuityBible,
  ContinuityShot,
} from "./continuity.js";

/** Canon-at-the-time bible for S01E05: Monica v1 (braids, apron-blue). */
export const bible: ContinuityBible = {
  characters: [
    {
      characterId: "CHAR_MONICA_BENNETT_001",
      appearances: [
        {
          versionLabel: "v1",
          hairVersion: "long-braids-v1",
          wardrobeVersion: "apron-blue",
        },
        {
          versionLabel: "v2",
          hairVersion: "short-hair-v2",
          wardrobeVersion: "sweater-green",
          effectiveEpisode: "S01E09",
        },
      ],
    },
  ],
  locations: [
    {
      locationId: "LOC_KITCHEN_001",
      dayNightStates: ["day", "night"],
    },
    {
      locationId: "LOC_LIVING_ROOM_001",
      dayNightStates: ["day"],
    },
  ],
};

/**
 * The continuity-break fixture. Shot 3 breaks every neighbor axis against
 * shot 2 and contradicts the bible (S01E05 → v1 canon).
 */
export const breakScene: readonly ContinuityShot[] = [
  {
    shotId: "SHOT_S01E05_001",
    sceneId: "SCENE_KITCHEN_001",
    sequenceIndex: 1,
    episode: "S01E05",
    location: "LOC_KITCHEN_001",
    timeOfDay: "day",
    characters: ["CHAR_MONICA_BENNETT_001"],
    wardrobe: { CHAR_MONICA_BENNETT_001: "apron-blue" },
    hair: { CHAR_MONICA_BENNETT_001: "long-braids-v1" },
    props: ["PROP_COFFEE_MUG_001"],
    startState: "door-closed",
    endState: "door-open",
  },
  {
    shotId: "SHOT_S01E05_002",
    sceneId: "SCENE_KITCHEN_001",
    sequenceIndex: 2,
    episode: "S01E05",
    location: "LOC_KITCHEN_001",
    timeOfDay: "day",
    characters: ["CHAR_MONICA_BENNETT_001"],
    wardrobe: { CHAR_MONICA_BENNETT_001: "apron-blue" },
    hair: { CHAR_MONICA_BENNETT_001: "long-braids-v1" },
    props: ["PROP_COFFEE_MUG_001"],
    startState: "door-open",
    endState: "door-open",
  },
  {
    shotId: "SHOT_S01E05_003",
    sceneId: "SCENE_KITCHEN_001",
    sequenceIndex: 3,
    episode: "S01E05",
    location: "LOC_LIVING_ROOM_001",
    timeOfDay: "night",
    characters: ["CHAR_MONICA_BENNETT_001"],
    wardrobe: { CHAR_MONICA_BENNETT_001: "sweater-green" },
    hair: { CHAR_MONICA_BENNETT_001: "short-hair-v2" },
    props: [],
    startState: "lights-off",
    endState: "lights-off",
  },
];

/** Control fixture: consistent neighbors, bible-matching, zero findings. */
export const cleanScene: readonly ContinuityShot[] = [
  {
    shotId: "SHOT_S01E05_101",
    sceneId: "SCENE_KITCHEN_001",
    sequenceIndex: 1,
    episode: "S01E05",
    location: "LOC_KITCHEN_001",
    timeOfDay: "day",
    characters: ["CHAR_MONICA_BENNETT_001"],
    wardrobe: { CHAR_MONICA_BENNETT_001: "Apron-Blue" },
    hair: { CHAR_MONICA_BENNETT_001: "long-braids-v1" },
    props: ["PROP_COFFEE_MUG_001"],
    startState: "door-closed",
    endState: "door-open",
  },
  {
    shotId: "SHOT_S01E05_102",
    sceneId: "SCENE_KITCHEN_001",
    sequenceIndex: 2,
    episode: "S01E05",
    location: "LOC_KITCHEN_001",
    timeOfDay: "day",
    characters: ["CHAR_MONICA_BENNETT_001"],
    wardrobe: { CHAR_MONICA_BENNETT_001: "apron-blue" },
    hair: { CHAR_MONICA_BENNETT_001: "long-braids-v1" },
    props: ["PROP_COFFEE_MUG_001", "PROP_SPOON_001"],
    startState: "door-open",
    endState: "door-open",
  },
];
