/**
 * Fixture screenplays with known-duration ground truth for the ±10%
 * acceptance test (DIR-005). Each fixture pairs a structured screenplay
 * with the runtime the estimator MUST produce for it — computed by hand
 * from the same published defaults (2.5 dialogue wps, 4.0 action wps,
 * 1.5s scene overhead, 3s scene floor), not by calling the estimator.
 */

import type { ScreenplayInput } from "./types.js";

export interface KnownDurationFixture {
  readonly name: string;
  readonly screenplay: ScreenplayInput;
  /** Expected total seconds under the default options. */
  readonly expectedTotalSeconds: number;
  /** Expected per-scene seconds under the default options (same order). */
  readonly expectedSceneSeconds: number[];
}

/**
 * "Coffee at Dawn" — single dialogue-heavy scene.
 * SC01: 41 dialogue words → 16.4s; 22 action words → 5.5s; +1.5 overhead = 23.4s.
 */
export const COFFEE_AT_DAWN: KnownDurationFixture = {
  name: "coffee-at-dawn",
  screenplay: {
    id: "FIXTURE_COFFEE_AT_DAWN",
    title: "Coffee at Dawn",
    scenes: [
      {
        id: "SC01",
        title: "Kitchen — morning",
        elements: [
          {
            kind: "action",
            text: "Sunlight cuts across a small kitchen. Monica pours two cups and waits.",
          },
          {
            kind: "dialogue",
            character: "MONICA",
            text: "You kept me waiting again. Thirty years and you still cannot be on time for coffee.",
          },
          {
            kind: "dialogue",
            character: "MARCUS",
            text: "The bus was late. The city was late. Everything except you was late.",
          },
          {
            kind: "action",
            text: "She slides a cup across the counter without looking up.",
          },
          {
            kind: "dialogue",
            character: "MONICA",
            text: "One day the coffee will be cold and you will deserve it.",
          },
        ],
      },
    ],
  },
  expectedTotalSeconds: 23.4,
  expectedSceneSeconds: [23.4],
};

/**
 * "Rooftop Pursuit" — three scenes, action-heavy with one dialogue beat.
 * SC01: 9 action words → 2.25s; +1.5 overhead = 3.75s.
 * SC02: 27 dialogue words → 10.8s; 7 action words → 1.75s; +1.5 = 14.05s.
 * SC03: 14 action words → 3.5s; +1.5 = 5s.
 * Total = 22.8s.
 */
export const ROOFTOP_PURSUIT: KnownDurationFixture = {
  name: "rooftop-pursuit",
  screenplay: {
    id: "FIXTURE_ROOFTOP_PURSUIT",
    title: "Rooftop Pursuit",
    scenes: [
      {
        id: "SC01",
        title: "Rooftop — night",
        elements: [{ kind: "action", text: "Marcus sprints across gravel rooftops under a red moon." }],
      },
      {
        id: "SC02",
        title: "Rooftop ledge",
        elements: [
          { kind: "action", text: "He stops at the edge, breathing hard." },
          {
            kind: "dialogue",
            character: "MARCUS",
            text: "You knew they would follow. You knew and you brought me here anyway.",
          },
          {
            kind: "dialogue",
            character: "HARRIS",
            text: "I brought you where the truth lives. It was never going to be comfortable.",
          },
        ],
      },
      {
        id: "SC03",
        title: "Alley — escape",
        elements: [
          {
            kind: "action",
            text: "Marcus drops into the alley, rolls through wet cardboard, and disappears into the crowd.",
          },
        ],
      },
    ],
  },
  expectedTotalSeconds: 22.8,
  expectedSceneSeconds: [3.75, 14.05, 5],
};

/**
 * "Quiet Hours" — empty scene exercising the minimum-scene floor.
 * SC01: no elements → 0 + 1.5 overhead → clamped to the 3s floor.
 * SC02: 18 dialogue words → 7.2s; +1.5 = 8.7s. Total = 11.7s.
 */
export const QUIET_HOURS: KnownDurationFixture = {
  name: "quiet-hours",
  screenplay: {
    id: "FIXTURE_QUIET_HOURS",
    title: "Quiet Hours",
    scenes: [
      { id: "SC01", title: "Empty stage", elements: [] },
      {
        id: "SC02",
        title: "Study",
        elements: [
          {
            kind: "dialogue",
            character: "MONICA",
            text: "I have read this page four times now and it still will not tell me why he left.",
          },
        ],
      },
    ],
  },
  expectedTotalSeconds: 11.7,
  expectedSceneSeconds: [3, 8.7],
};

export const KNOWN_DURATION_FIXTURES: readonly KnownDurationFixture[] = [
  COFFEE_AT_DAWN,
  ROOFTOP_PURSUIT,
  QUIET_HOURS,
];