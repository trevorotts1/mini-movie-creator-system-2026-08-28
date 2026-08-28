/**
 * The dialogue/captions layer component (VID-004, spec §21 — Remotion owns
 * captions). Drop-in timeline layer: mount inside the episode/scene
 * composition (optionally wrapped in a <Sequence from={startFrame}>), hand
 * it the CaptionTrack built from the FISH-007 alignment, and it renders
 * word-exact captions synced to the audio.
 *
 * Rendering discipline preserved from the upstream Shorts kit
 * (remotion/src/lib/shorts.tsx Captions): one chunk at a time; the
 * currently-spoken word pops in the accent color; no caption outside the
 * safe zone by default; the component is a pure function of the current
 * frame + the track (deterministic, re-render safe).
 */

import React from "react";
import {
  AbsoluteFill,
  Easing,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { CaptionTrackError } from "./errors.js";
import {
  activeChunkAt,
  CAPTION_DEFAULTS,
  chunkTrack,
} from "./track.js";
import { msToFrame } from "./timing.js";
import type { CaptionStyleOptions } from "./types.js";

/** 0..1 progress of t through [a,b], clamped — degenerate-range-proof
 * (upstream prog()). */
const prog = (t: number, a: number, b: number): number =>
  Math.max(0, Math.min(1, (t - a) / Math.max(0.0001, b - a)));

const EASE_OUT = Easing.bezier(0.33, 1, 0.68, 1);

export interface CaptionsLayerProps {
  /** The word-exact caption track (from buildCaptionTrack). */
  track: CaptionTrackLike;
  /** Visual style; defaults mirror the upstream Shorts kit. */
  style?: CaptionStyleOptions;
}

/** Structural track shape the renderer needs (satisfied by CaptionTrack;
 * declared separately so test harnesses can hand a minimal stand-in). */
export interface CaptionTrackLike {
  readonly fps: number;
  readonly startFrame: number;
  readonly words: ReadonlyArray<{
    readonly word: string;
    readonly startMs: number;
    readonly endMs: number;
  }>;
}

/**
 * Word-exact captions layer. Renders nothing when no chunk is active at
 * the current frame (between dialogue lines) — never a stale caption.
 *
 * Word highlight boundary = the alignment's own ms→frames conversion at
 * the TRACK's fps (the same numbers buildCaptionTrack/chunkTrack used), so
 * caption frame == alignment ms→frames by construction.
 */
export const CaptionsLayer: React.FC<CaptionsLayerProps> = ({
  track,
  style = {},
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  if (typeof track?.fps !== "number" || track.fps <= 0) {
    throw new CaptionTrackError(
      "CaptionsLayer: track.fps missing or invalid — build the track with buildCaptionTrack()",
    );
  }
  // The track was built at its own fps; the composition must agree or the
  // word boundaries would silently shift (29.97 vs 30 drifts by frame 100).
  // Exact compare on the rounded value the ms→frames math actually used.
  if (fps !== track.fps) {
    throw new CaptionTrackError(
      `CaptionsLayer: composition fps ${fps} != track fps ${track.fps} — rebuild the track at the composition fps`,
    );
  }

  const {
    y = CAPTION_DEFAULTS.y,
    size = CAPTION_DEFAULTS.size,
    accent = CAPTION_DEFAULTS.accent,
    maxWords = CAPTION_DEFAULTS.maxWords,
    plate = CAPTION_DEFAULTS.plate,
    fontFamily = FONT_STACK,
  } = style;

  const chunks = React.useMemo(
    () =>
      chunkTrack(
        // CaptionTrack satisfies this shape; the structural interface keeps
        // the renderer usable with any ms-timed track.
        track as import("./types.js").CaptionTrack,
        maxWords,
      ),
    [track, maxWords],
  );
  const active = activeChunkAt(chunks, frame);
  if (!active) return null;

  const enter = prog(frame, active.startFrame, active.startFrame + 0.14 * fps);

  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
      <div
        style={{
          position: "absolute",
          left: 40,
          right: 40,
          top: y,
          transform: `translateY(${(1 - EASE_OUT(enter)) * 14 - 50}%)`,
          opacity: 0.25 + 0.75 * enter,
          display: "flex",
          justifyContent: "center",
        }}
      >
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            justifyContent: "center",
            alignItems: "center",
            columnGap: size * 0.28,
            rowGap: size * 0.14,
            maxWidth: "100%",
            ...(plate
              ? {
                  background: "rgba(13,17,23,0.86)",
                  borderRadius: 22,
                  padding: `${size * 0.28}px ${size * 0.5}px`,
                  boxShadow: "0 12px 48px rgba(0,0,0,0.35)",
                }
              : {}),
          }}
        >
          {active.words.map((word, i) => {
            // Alignment boundary in frames — same conversion the track was
            // built with. startFrame is baked into BOTH the chunk frames and
            // the word boundaries (global timeline space), so the highlight
            // can never drift from the chunk it sits inside.
            const start = msToFrame(word.startMs, fps, track.startFrame);
            const end = msToFrame(word.endMs, fps, track.startFrame);
            const started = prog(frame, start, start + 0.12 * fps);
            const isActive =
              frame >= start &&
              frame < Math.max(end, start + 1) + Math.round(0.05 * fps);
            return (
              <span
                key={i}
                style={{
                  fontFamily,
                  fontWeight: 700,
                  fontSize: size,
                  lineHeight: 1.15,
                  textTransform: "uppercase",
                  letterSpacing: 0.5,
                  color: isActive
                    ? String(accent)
                    : "#ffffff",
                  opacity: 0.3 + 0.7 * started,
                  transform: `scale(${
                    0.92 + 0.08 * EASE_OUT(started) + (isActive ? 0.05 : 0)
                  })`,
                  textShadow:
                    "0 3px 26px rgba(0,0,0,0.65), 0 1px 4px rgba(0,0,0,0.5)",
                }}
              >
                {/* Untrusted dialogue text (spec §21): React escapes text
                    nodes; never dangerouslySetInnerHTML. */}
                {word.word}
              </span>
            );
          })}
        </div>
      </div>
    </AbsoluteFill>
  );
};

/** Default caption font stack (bold display look of the upstream kit;
 * the composition may override via style.fontFamily). */
export const FONT_STACK =
  '"Inter", "Helvetica Neue", Arial, sans-serif';