import React from "react";
import { AbsoluteFill, Img, OffthreadVideo, Sequence } from "remotion";

import type { PlacedGeneratedClip } from "./types.js";

/**
 * VID-005 — Remotion rendering of one placed generated clip.
 *
 * The layer assembles pure slot data ({@link PlacedGeneratedClip}); this
 * component turns one placement into a Remotion `<Sequence>` so the episodic
 * timeline (VID-002/VID-012) can compose generated-clip slots alongside the
 * still-motion, stock, graphics, captions and audio layers.
 *
 * Local-frame discipline: the placement carries the GLOBAL `fromFrame`
 * (`round(inSeconds * fps)`); inside the `<Sequence>` the shot component
 * reads local frames from 0 — the upstream conversion
 * `local_f = global_s * fps − sequence_from` collapses to `local_f =
 * global_f − fromFrame`, which Remotion's `<Sequence>` performs natively.
 */

/** Styling hooks for the slot (letterbox/fit behavior). */
export interface GeneratedClipVisualProps {
  /** Fit the clip inside the frame preserving aspect (default "cover"). */
  readonly fit?: "cover" | "contain";
  /** Optional background behind letterboxed clips. */
  readonly background?: string;
}

/** One placed generated clip as a timeline `<Sequence>`. */
export const GeneratedClipSequence: React.FC<
  { clip: PlacedGeneratedClip } & GeneratedClipVisualProps
> = ({ clip, fit = "cover", background = "#000" }) => {
  return (
    <Sequence
      key={clip.shotId}
      from={clip.fromFrame}
      durationInFrames={clip.durationInFrames}
      name={`shot:${clip.shotId}`}
    >
      <AbsoluteFill style={{ backgroundColor: background }}>
        <OffthreadVideo
          src={clip.sourceUrl}
          muted
          style={
            fit === "contain"
              ? {
                  width: "100%",
                  height: "100%",
                  objectFit: "contain",
                }
              : {
                  width: "100%",
                  height: "100%",
                  objectFit: "cover",
                }
          }
        />
      </AbsoluteFill>
    </Sequence>
  );
};

/** The whole assembled generated-clip layer as timeline sequences. */
export const GeneratedClipLayer: React.FC<{
  clips: readonly PlacedGeneratedClip[];
  fit?: "cover" | "contain";
  background?: string;
}> = ({ clips, fit, background }) => (
  <>
    {clips.map((clip) => (
      <GeneratedClipSequence
        key={clip.shotId}
        clip={clip}
        fit={fit}
        background={background}
      />
    ))}
  </>
);

/**
 * Poster/placeholder frame for QC views and pre-approval previews: the clip's
 * slot rendered as a labeled still (no media fetch) when the real clip is not
 * yet renderable in the preview environment.
 */
export const GeneratedClipPoster: React.FC<
  { clip: PlacedGeneratedClip } & GeneratedClipVisualProps
> = ({ clip, background = "#101014" }) => (
  <Sequence
    from={clip.fromFrame}
    durationInFrames={clip.durationInFrames}
    name={`shot:${clip.shotId}`}
  >
    <AbsoluteFill style={{ backgroundColor: background }}>
      <Img
        src={clip.sourceUrl}
        style={{ width: "100%", height: "100%", objectFit: "cover" }}
        onError={() => undefined}
      />
      <AbsoluteFill
        style={{
          justifyContent: "flex-end",
          padding: 24,
          color: "#eee",
          fontFamily: "sans-serif",
          fontSize: 18,
        }}
      >
        {`shot ${clip.shotId} · ${clip.assetId}`}
      </AbsoluteFill>
    </AbsoluteFill>
  </Sequence>
);