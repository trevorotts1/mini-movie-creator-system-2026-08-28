/// <reference types="node" />
import { describe, expect, it } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Internals } from "remotion";

import { GeneratedClipLayer, GeneratedClipSequence } from "./index.js";
import type { PlacedGeneratedClip } from "./index.js";

const CLIP_A: PlacedGeneratedClip = {
  shotId: "S01E03_SC04_SH01",
  sceneId: "S01E03_SC04",
  sequenceIndex: 0,
  assetId: "ASSET_SH01",
  sourceUrl: "https://storage.example/SH01.mp4",
  inSeconds: 0,
  outSeconds: 6,
  fromFrame: 0,
  durationInFrames: 180,
  clipFps: 30,
  fullyCovered: true,
};

const CLIP_B: PlacedGeneratedClip = {
  shotId: "S01E03_SC04_SH02",
  sequenceIndex: 1,
  assetId: "ASSET_SH02",
  sourceUrl: "https://storage.example/SH02.mp4",
  inSeconds: 6,
  outSeconds: 14,
  fromFrame: 180,
  durationInFrames: 240,
  clipFps: 30,
  fullyCovered: false,
};

/**
 * Remotion's <Sequence> reads the composition-manager + timeline contexts
 * (useVideoConfig / useTimelinePosition). Under react-dom/server there is no
 * <Composition> registration, so the test mounts the layer inside Remotion's
 * own providers with a minimal composition registered and a per-composition
 * frame map placing the playhead inside the active clip's slot.
 *
 * The provider values are shaped against Remotion's internal runtime
 * contract; their TS types are internal-only, so the provider elements are
 * built through a loose element type (values verified by the tests passing
 * against real Remotion behavior).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
const COMPOSITION: any = {
  id: "TestGeneratedClips",
  component: null,
  durationInFrames: 600,
  fps: 30,
  width: 1920,
  height: 1080,
  defaultProps: {},
  defaultCodec: null,
  defaultOutName: null,
  defaultVideoImageFormat: null,
  defaultPixelFormat: null,
  defaultProResProfile: null,
  defaultSampleRate: null,
  folderName: null,
  parentFolderName: null,
  nonce: 0,
  schema: null,
  calculateMetadata: null,
  defaultLoopDisplay: null,
  defaultTrimBefore: null,
  defaultTrimAfter: null,
};

function el(
  type: React.ComponentType<unknown> | string,
  props: unknown,
  ...children: React.ReactNode[]
): React.ReactElement {
  return React.createElement(type as never, props as never, ...children);
}

function renderInRemotionContext(
  ui: React.ReactElement,
  frame: number | Record<string, number> = 100,
): string {
  const frameState: Record<string, number> =
    typeof frame === "number" ? { [COMPOSITION.id]: frame } : frame;
  return renderToStaticMarkup(
    el(
      Internals.TimelineContext.Provider as never,
      {
        value: {
          frame: frameState,
          playing: false,
          rootId: COMPOSITION.id,
          imperativePlaying: { current: false },
          setPlaybackRate: () => undefined,
        },
      },
      el(
        Internals.CompositionManager.Provider as never,
        {
          value: {
            compositions: [COMPOSITION],
            folders: [],
            currentCompositionMetadata: null,
            canvasContent: {
              type: "composition",
              compositionId: COMPOSITION.id,
            },
          },
        },
        el(
          Internals.PlaybackRateContext.Provider as never,
          { value: 1 },
          el(
            Internals.BufferingProvider as never,
            { value: { buffering: new Set(), bufferingListeners: [] } },
            el(
              Internals.SharedAudioContextProvider as never,
              { numberOfSharedAudioTags: 0 },
              el(
                Internals.CanUseRemotionHooks.Provider as never,
                { value: true },
                ui,
              ),
            ),
          ),
        ),
      ),
    ),
  );
}

describe("GeneratedClipLayer component", () => {
  it("renders one Sequence per placed clip with from/duration from the placement", () => {
    const markup = renderInRemotionContext(
      React.createElement(GeneratedClipLayer, { clips: [CLIP_A, CLIP_B] }),
      100, // inside CLIP_A's [0,180) slot; CLIP_B's sequence body is skipped
    );

    // The active slot renders the media with the GHL-resolved URL verbatim.
    expect(markup).toContain("https://storage.example/SH01.mp4");
    // The inactive slot contributes no rendered media (frame 100 < from 180).
    expect(markup).not.toContain("https://storage.example/SH02.mp4");
  });

  it("activates each clip exactly inside its own slot", () => {
    // Frame 100: only CLIP_A (slot 0–180).
    const at100 = renderInRemotionContext(
      React.createElement(GeneratedClipLayer, { clips: [CLIP_A, CLIP_B] }),
      100,
    );
    expect(at100).toContain("SH01.mp4");
    expect(at100).not.toContain("SH02.mp4");

    // Frame 300: only CLIP_B (slot 180–420).
    const at300 = renderInRemotionContext(
      React.createElement(GeneratedClipLayer, { clips: [CLIP_A, CLIP_B] }),
      300,
    );
    expect(at300).toContain("SH02.mp4");
    expect(at300).not.toContain("SH01.mp4");
  });

  it("places a single sequence with layout none passing media src through", () => {
    const markup = renderInRemotionContext(
      React.createElement(GeneratedClipSequence, {
        clip: CLIP_A,
        fit: "contain",
      }),
      100,
    );
    expect(markup).toContain("https://storage.example/SH01.mp4");
  });
});