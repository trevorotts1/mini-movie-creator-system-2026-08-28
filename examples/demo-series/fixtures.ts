/**
 * REL-003 demo-series fixtures — "Mona & the Brass Key", episode S01E01.
 *
 * Everything here is DATA. Story text is untrusted input (spec §29): the
 * pipeline stores it verbatim into record fields and never parses or
 * executes it. No paid generation anywhere — the only executable image
 * client is the storyboard module's MockImageClient.
 */

/* ------------------------------------------------------------------ */
/* Capability-seed → planner-profile mappings                          */
/* ------------------------------------------------------------------ */

import type {
  KeyframeCapabilityProfile,
} from "../../packages/scene-intelligence/src/keyframe-planner/index.js";
import type {
  ImageCapabilityProfile,
} from "../../packages/scene-intelligence/src/storyboard/index.js";
import type {
  ReferenceCapability,
} from "../../packages/scene-intelligence/src/reference-budget/index.js";
import {
  AGNES_IMAGE_2_1_FLASH,
  AGNES_VIDEO_2_5_FLASH,
} from "../../packages/capability-registry/src/data/agnes.js";

/** Video-model constraints input for the shot planner, straight from the seed. */
export const DEMO_VIDEO_MODEL = {
  provider: AGNES_VIDEO_2_5_FLASH.provider,
  modelId: AGNES_VIDEO_2_5_FLASH.modelId,
  minDurationSeconds: AGNES_VIDEO_2_5_FLASH.output.minDurationSeconds ?? null,
  maxDurationSeconds: AGNES_VIDEO_2_5_FLASH.output.maxDurationSeconds ?? null,
  pricing: AGNES_VIDEO_2_5_FLASH.pricing,
} as const;

/** Keyframe-planner capability profile from the seed's references block. */
export const DEMO_KEYFRAME_PROFILE: KeyframeCapabilityProfile = {
  firstFrame: AGNES_VIDEO_2_5_FLASH.references.firstFrame,
  lastFrame: AGNES_VIDEO_2_5_FLASH.references.lastFrame,
  firstLastFrame: AGNES_VIDEO_2_5_FLASH.references.firstLastFrame,
  multimodalReferences: AGNES_VIDEO_2_5_FLASH.references.multimodalReferences,
  maxImages: AGNES_VIDEO_2_5_FLASH.references.maxImages,
};

/** Reference-budget capability from the same seed (type axes added). */
export const DEMO_REFERENCE_CAPABILITY: ReferenceCapability = {
  maxImages: AGNES_VIDEO_2_5_FLASH.references.maxImages,
  firstFrame: AGNES_VIDEO_2_5_FLASH.references.firstFrame,
  lastFrame: AGNES_VIDEO_2_5_FLASH.references.lastFrame,
  firstLastFrame: AGNES_VIDEO_2_5_FLASH.references.firstLastFrame,
  multimodalReferences: AGNES_VIDEO_2_5_FLASH.references.multimodalReferences,
  allowedReferenceTypes: null,
  incompatibleCombinations: AGNES_VIDEO_2_5_FLASH.references.incompatibleCombinations,
};

/** Image-capability profile for the storyboard contract, from the image seed. */
export const DEMO_IMAGE_PROFILE: ImageCapabilityProfile = {
  provider: AGNES_IMAGE_2_1_FLASH.provider,
  modelId: AGNES_IMAGE_2_1_FLASH.modelId,
  aspectRatios: AGNES_IMAGE_2_1_FLASH.output.aspectRatios,
  resolutions: AGNES_IMAGE_2_1_FLASH.output.resolutions,
  maxImages: AGNES_IMAGE_2_1_FLASH.references.maxImages,
  hardMaxCharacters: AGNES_IMAGE_2_1_FLASH.prompt.hardMaxCharacters,
  recommendedMaxCharacters: AGNES_IMAGE_2_1_FLASH.prompt.recommendedMaxCharacters,
  multimodalReferences: AGNES_IMAGE_2_1_FLASH.references.multimodalReferences,
  confidence: AGNES_IMAGE_2_1_FLASH.confidence,
};

/* ------------------------------------------------------------------ */
/* Intake + concept (gate 1 fixture — mock director-model transport)   */
/* ------------------------------------------------------------------ */

export const DEMO_INTAKE = {
  intakeId: "idea_demo000000000000000000000000000000",
  rawText:
    "Mona, a night-shift library cat, finds a brass key that opens a door " +
    "between the library's shelves. Behind it: the Overdue Room, where every " +
    "book ever lost waits to be finished. Her keeper Juno has lost one story " +
    "Mona loved — with the library closing forever at dawn, Mona has one " +
    "night to bring it back.",
  aspectRatio: "16:9",
  targetRuntimeSeconds: 300,
  seriesLink: null,
  createdAt: "2026-08-29T00:00:00.000Z",
} as const;

/** Well-formed mock director-model response (recommended option first). */
export const DEMO_CONCEPT_RESPONSE_BODY = {
  options: [
    {
      title: "The Overdue Room",
      logline:
        "A library cat must return a lost story before the library closes forever at dawn.",
      premise:
        "When Mona finds a brass key that opens a door between the shelves, she " +
        "discovers the Overdue Room — where every lost book waits to be finished. " +
        "Juno has lost the one story Mona loved, and demolition starts at dawn. " +
        "Mona recruits the room's resident ink-blot to rewrite the ending, and " +
        "learns that some stories only finish themselves when read aloud.",
      genre: "Family fantasy",
      tone: "cozy, moonlit wonder",
      visualStyle: "warm lamplight, dusty sunbeams, ink-and-paper textures",
      standoutMoments: [
        "the brass key turns between shelves",
        "the ink-blot signs the last page",
        "dawn light hits the 'CLOSED' sign",
      ],
      risks: ["night-time lamp-position continuity", "ink-blot shape consistency"],
      recommended: true,
      suggestedRuntimeSeconds: null,
      suggestedAspectRatio: null,
      suggestedEpisodeCount: 3,
    },
    {
      title: "Dewey Decimates",
      logline:
        "A library cat accidentally awakens the Dewey decimal system as a golem.",
      premise:
        "Mona's midnight yawn shatters the card catalog into a numbering golem " +
        "that reorganizes the whole town. To undo it she must file herself back " +
        "into the drawer she was born in.",
      genre: "Comedy",
      tone: "slapstick",
      visualStyle: "cardboard diorama",
      standoutMoments: ["the catalog avalanche"],
      risks: [],
      recommended: false,
      suggestedRuntimeSeconds: 240,
      suggestedAspectRatio: "9:16",
      suggestedEpisodeCount: null,
    },
  ],
  modelNotes: "Both options support the 3-episode demo arc.",
} as const;

/* ------------------------------------------------------------------ */
/* Screenplay (gate 2 fixture — fountain-style plain text)             */
/* ------------------------------------------------------------------ */

/**
 * Two scenes. Each beat carries an explicit durationHintSeconds so the shot
 * planner's Agnes 4–12s window is satisfied deterministically: scene 1 runs
 * 30s (target 5 shots in a 12s-max window needs 3 shots — 30/12 → ceil 3),
 * scene 2 runs 24s (2 shots). Every scene has at least as many beats as
 * shots so no shot is forced empty.
 */
export const DEMO_SCREENPLAY = `TITLE: Mona & the Brass Key — S01E01 "The Overdue Room"

INT. HOLLOW PINE LIBRARY - READING ROOM - NIGHT

Moonlight stripes the empty reading room. MONA, a small grey
library cat, pads between the shelves. JUNO, the night librarian,
closes a ledger at the front desk.

MONA
(soft)
One more round, Juno. Then breakfast.

JUNO
Last round, Mona. Then lights out.

Mona's paw brushes a loose floorboard. A tarnished BRASS KEY
slides free and glints under the lamp.

MONA
(startled)
You were under the floor all along?

The bookcase behind her exhales dust. Somewhere deep in the
stacks, a door unlocks itself.

INT. HOLLOW PINE LIBRARY - THE OVERDUE ROOM - CONTINUOUS

The door opens onto a vast room of floating bookshelves. Every
book hovers with a small glowing date stamp. The ink-blot SMUDGE
peels off the floor and bows.

SMUDGE
You brought the key back. Took you nine years.

MONA
I want the story Juno lost. "The Cartographer's Daughter."

SMUDGE
(stacking himself into an arrow)
Then follow me, cat. But the room only keeps what is read aloud.

Mona steps onto a floating shelf. The door begins to swing shut
behind her — dawn edges creeps under it.
`;

/** Cast names asserted to the parser (matched in action prose). */
export const DEMO_KNOWN_CHARACTERS = ["MONA", "JUNO", "SMUDGE"] as const;

/* ------------------------------------------------------------------ */
/* PlannedScene views of the parsed screenplay (shot-planner input)    */
/* ------------------------------------------------------------------ */

import type { PlannedScene } from "../../packages/scene-intelligence/src/shot-planner/index.js";

export const DEMO_CHARACTER_VERSIONS = {
  mona: {
    characterId: "CHAR_DEMO_MONA_001",
    identityVersion: "mona-identity-v1",
    hairVersion: "mona-fur-v1",
    wardrobeVersion: "mona-collar-v1",
  },
  juno: {
    characterId: "CHAR_DEMO_JUNO_002",
    identityVersion: "juno-identity-v1",
    wardrobeVersion: "juno-cardigan-v1",
  },
  smudge: {
    characterId: "CHAR_DEMO_SMUDGE_003",
    identityVersion: "smudge-identity-v1",
    wardrobeVersion: "smudge-ink-v1",
  },
} as const;

/**
 * Scenes mirroring the screenplay's parse output, converted to the shot
 * planner's PlannedScene shape with beats the planner can cover. Durations
 * and beat counts satisfy the Agnes 4–12s window with no empty shots:
 * scene 1 → 30s (3 shots, 6 beats), scene 2 → 24s (2 shots, 4 beats).
 */
export const DEMO_PLANNED_SCENES: readonly PlannedScene[] = [
  {
    sceneId: "SC01",
    title: "Reading Room — Night",
    location: "LOC_LIBRARY_READING_ROOM",
    durationSeconds: 30,
    characters: [
      DEMO_CHARACTER_VERSIONS.mona,
      DEMO_CHARACTER_VERSIONS.juno,
    ],
    wardrobe: {
      [DEMO_CHARACTER_VERSIONS.mona.characterId]: DEMO_CHARACTER_VERSIONS.mona.wardrobeVersion,
      [DEMO_CHARACTER_VERSIONS.juno.characterId]: DEMO_CHARACTER_VERSIONS.juno.wardrobeVersion,
    },
    lighting: "moonlight stripes, warm desk lamp",
    props: ["brass key", "ledger"],
    timeOfDay: "night",
    beats: [
      {
        id: "SC01-B01",
        type: "establishing",
        description: "Moonlight stripes the empty reading room; Mona pads between the shelves.",
        characters: [DEMO_CHARACTER_VERSIONS.mona.characterId],
        durationHintSeconds: 6,
      },
      {
        id: "SC01-B02",
        type: "dialogue",
        description: "Mona checks in with Juno before the last round.",
        characters: [DEMO_CHARACTER_VERSIONS.mona.characterId, DEMO_CHARACTER_VERSIONS.juno.characterId],
        dialogue: [
          { characterId: DEMO_CHARACTER_VERSIONS.mona.characterId, text: "One more round, Juno. Then breakfast." },
          { characterId: DEMO_CHARACTER_VERSIONS.juno.characterId, text: "Last round, Mona. Then lights out." },
        ],
        durationHintSeconds: 8,
      },
      {
        id: "SC01-B03",
        type: "action",
        description: "Mona's paw brushes a loose floorboard; a brass key slides free and glints.",
        characters: [DEMO_CHARACTER_VERSIONS.mona.characterId],
        props: ["brass key"],
        durationHintSeconds: 6,
      },
      {
        id: "SC01-B04",
        type: "dialogue",
        description: "Mona startles at the key.",
        characters: [DEMO_CHARACTER_VERSIONS.mona.characterId],
        dialogue: [
          { characterId: DEMO_CHARACTER_VERSIONS.mona.characterId, text: "You were under the floor all along?" },
        ],
        durationHintSeconds: 4,
      },
      {
        id: "SC01-B05",
        type: "reaction",
        description: "The bookcase exhales dust; Mona's ears pin back.",
        characters: [DEMO_CHARACTER_VERSIONS.mona.characterId],
        emotion: "startled",
        durationHintSeconds: 3,
      },
      {
        id: "SC01-B06",
        type: "emotional",
        description: "Deep in the stacks, a door unlocks itself; Mona steps toward it.",
        characters: [DEMO_CHARACTER_VERSIONS.mona.characterId],
        durationHintSeconds: 3,
      },
    ],
  },
  {
    sceneId: "SC02",
    title: "The Overdue Room — Continuous",
    location: "LOC_LIBRARY_OVERDUE_ROOM",
    durationSeconds: 24,
    characters: [
      DEMO_CHARACTER_VERSIONS.mona,
      DEMO_CHARACTER_VERSIONS.smudge,
    ],
    wardrobe: {
      [DEMO_CHARACTER_VERSIONS.mona.characterId]: DEMO_CHARACTER_VERSIONS.mona.wardrobeVersion,
      [DEMO_CHARACTER_VERSIONS.smudge.characterId]: DEMO_CHARACTER_VERSIONS.smudge.wardrobeVersion,
    },
    lighting: "floating shelf-glow, cool key light",
    props: ["brass key", "the Cartographer's Daughter"],
    timeOfDay: "night",
    beats: [
      {
        id: "SC02-B01",
        type: "establishing",
        description: "The door opens onto floating bookshelves, every book with a glowing date stamp.",
        characters: [DEMO_CHARACTER_VERSIONS.mona.characterId],
        durationHintSeconds: 6,
      },
      {
        id: "SC02-B02",
        type: "dialogue",
        description: "Smudge bows and greets Mona; she names the story she came for.",
        characters: [DEMO_CHARACTER_VERSIONS.mona.characterId, DEMO_CHARACTER_VERSIONS.smudge.characterId],
        dialogue: [
          { characterId: DEMO_CHARACTER_VERSIONS.smudge.characterId, text: "You brought the key back. Took you nine years." },
          { characterId: DEMO_CHARACTER_VERSIONS.mona.characterId, text: "I want the story Juno lost." },
        ],
        durationHintSeconds: 8,
      },
      {
        id: "SC02-B03",
        type: "action",
        description: "Smudge stacks himself into an arrow pointing deeper into the room.",
        characters: [DEMO_CHARACTER_VERSIONS.smudge.characterId],
        durationHintSeconds: 4,
      },
      {
        id: "SC02-B04",
        type: "emotional",
        description: "Mona steps onto a floating shelf; the door begins to swing shut as dawn creeps under it.",
        characters: [DEMO_CHARACTER_VERSIONS.mona.characterId],
        emotion: "determined",
        durationHintSeconds: 6,
      },
    ],
  },
];

/** Scene-master classification input (from the parsed scene shapes). */
export const DEMO_SCENE_MASTER_INPUTS = [
  {
    sceneId: "SC01",
    characters: [
      DEMO_CHARACTER_VERSIONS.mona.characterId,
      DEMO_CHARACTER_VERSIONS.juno.characterId,
    ],
    speakingCharacters: [
      DEMO_CHARACTER_VERSIONS.mona.characterId,
      DEMO_CHARACTER_VERSIONS.juno.characterId,
    ],
    importance: "high" as const,
  },
  {
    sceneId: "SC02",
    characters: [
      DEMO_CHARACTER_VERSIONS.mona.characterId,
      DEMO_CHARACTER_VERSIONS.smudge.characterId,
    ],
    speakingCharacters: [
      DEMO_CHARACTER_VERSIONS.smudge.characterId,
    ],
    importance: "hero" as const,
  },
];