/**
 * DIR-010 fixture — the 45-second reference scene (spec §7 acceptance:
 * "a 45-second scene is typically 5–8 shots").
 *
 * Two characters, six beats (establishing / dialogue / reaction / emotional /
 * action / insert), dialogue lengths estimated to a ~45s scene. Story text is
 * fixture data — untrusted content, never executed.
 */

import type { PlannedScene } from "./types.js";

export const FORTY_FIVE_SECOND_SCENE: PlannedScene = Object.freeze({
  sceneId: "SC04",
  title: "Monica confronts Harris",
  location: "LOC_HARRIS_APARTMENT_NIGHT",
  timeOfDay: "night",
  lighting: "practical lamps, cool window moonlight",
  durationSeconds: 45,
  characters: [
    {
      characterId: "CHAR_MONICA_BENNETT_001",
      identityVersion: "v1",
      hairVersion: "long-braids-v1",
      wardrobeVersion: "business-blue-v1",
    },
    {
      characterId: "CHAR_HARRIS_COLE_001",
      identityVersion: "v1",
      hairVersion: "short-fade-v1",
      wardrobeVersion: "grey-henley-v1",
    },
  ],
  props: ["manila envelope", "half-finished coffee"],
  beats: [
    {
      id: "B01",
      type: "establishing",
      description:
        "Harris's apartment at night, blinds slicing moonlight across the room",
      characters: [],
      durationHintSeconds: 6,
    },
    {
      id: "B02",
      type: "dialogue",
      description: "Monica drops the envelope on the table and demands answers",
      characters: ["CHAR_MONICA_BENNETT_001", "CHAR_HARRIS_COLE_001"],
      dialogue: [
        {
          characterId: "CHAR_MONICA_BENNETT_001",
          text: "You told me the ledger was closed. So explain this.",
        },
        ],
      emotion: "controlled anger",
      durationHintSeconds: 8,
    },
    {
      id: "B03",
      type: "reaction",
      description: "Harris freezes, eyes flicking to the envelope",
      characters: ["CHAR_HARRIS_COLE_001"],
      durationHintSeconds: 5,
    },
    {
      id: "B04",
      type: "emotional",
      description:
        "Monica's voice cracks as she realizes he has been lying for months",
      characters: ["CHAR_MONICA_BENNETT_001"],
      dialogue: [
        {
          characterId: "CHAR_MONICA_BENNETT_001",
          text: "I defended you to everyone. Every single time.",
        },
      ],
      emotion: "hurt",
      durationHintSeconds: 9,
    },
    {
      id: "B05",
      type: "action",
      description:
        "Harris lunges for the envelope; Monica pulls it back and steps away",
      characters: ["CHAR_MONICA_BENNETT_001", "CHAR_HARRIS_COLE_001"],
      durationHintSeconds: 10,
    },
    {
      id: "B06",
      type: "insert",
      description: "Close on the envelope's torn seal, Harris's name on the label",
      characters: [],
      durationHintSeconds: 7,
    },
  ],
}) as PlannedScene;

/** Short scene for merge behavior (fits a single model window). */
export const EIGHT_SECOND_SCENE: PlannedScene = Object.freeze({
  sceneId: "SC05",
  location: "LOC_STREET_DAWN",
  durationSeconds: 8,
  characters: [
    {
      characterId: "CHAR_MONICA_BENNETT_001",
      identityVersion: "v1",
      wardrobeVersion: "business-blue-v1",
    },
  ],
  beats: [
    {
      id: "B01",
      type: "establishing",
      description: "Empty street at dawn",
      characters: [],
      durationHintSeconds: 4,
    },
    {
      id: "B02",
      type: "action",
      description: "Monica walks out of frame left",
      characters: ["CHAR_MONICA_BENNETT_001"],
      durationHintSeconds: 4,
    },
  ],
}) as PlannedScene;