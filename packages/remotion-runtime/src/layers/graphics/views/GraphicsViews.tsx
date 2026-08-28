/**
 * Remotion view components for the native graphics layer (VID-008).
 *
 * Thin, declarative-only wrappers over the pure core (../layout, ../compose,
 * ../credits): every frame position, opacity, translate, and layout number
 * comes from the core math; these components only map resolved data to DOM.
 * Story text renders as React text children only — never injected markup
 * (spec §29: story text is untrusted data).
 *
 * This file is excluded from the package's strict tsconfig/test surface (the
 * `remotion` peer is resolved inside the upstream `remotion/` project). VID-012
 * mounts these in the episodic composition's native-graphics sequence.
 */
import React from "react";
import { AbsoluteFill, Easing, useCurrentFrame, useVideoConfig } from "remotion";

import { composeGraphics, DEFAULT_FRAME, DEFAULT_SAFE_AREA, type GraphicsStack } from "../compose.js";
import { anchorBlock, envelopeAt, resolveTiming, type ResolvedGraphicsItem } from "../layout.js";
import { GRAPHICS_FONTS, GRAPHICS_GRADIENT, GRAPHICS_RADIUS, GRAPHICS_SHADOW } from "../tokens.js";
import { creditsScrollAt, type CreditsTimeline } from "../credits.js";
import type { FrameSize, SafeArea } from "../types.js";

const EASE_OUT = Easing.bezier(0.33, 1, 0.68, 1);
void EASE_OUT; // brand reference; core math already emits eased envelopes

/** Wrapper positioning per resolved item. */
function itemStyle(it: ResolvedGraphicsItem, frame: FrameSize, safe: SafeArea): React.CSSProperties {
  const block = anchorBlock(it.anchor, frame, safe);
  const env = envelopeAt(frame, it.range, it.timing);
  return {
    position: "absolute",
    left: block.align === "left" ? block.x : undefined,
    right: block.align === "right" ? frame.width - block.x : undefined,
    top: block.y + env.translateY,
    width: block.align === "center" ? "100%" : undefined,
    textAlign: block.align === "center" ? "center" : block.align,
    display: block.align === "center" ? "flex" : "block",
    justifyContent: block.align === "center" ? "center" : undefined,
    opacity: env.opacity,
    zIndex: it.zIndex,
    fontFamily: it.spec.kind === "title" || it.spec.kind === "kicker" ? GRAPHICS_FONTS.display : GRAPHICS_FONTS.body,
    fontSize: it.fontSizeScaled,
    color: it.color,
  };
}

/** Single graphics item renderer. */
export const GraphicsItemView: React.FC<{
  item: ResolvedGraphicsItem;
  frameSize?: FrameSize;
  safeArea?: SafeArea;
}> = ({ item, frameSize = DEFAULT_FRAME, safeArea = DEFAULT_SAFE_AREA }) => {
  const style = itemStyle(item, frameSize, safeArea);
  const lines = item.lines;

  if (item.spec.kind === "progressBar") {
    const { width } = frameSize;
    const p = Math.min(1, Math.max(0, item.spec.panel?.progress ?? 0));
    return (
      <div style={{ ...style, top: style.top as number }}>
        <div style={{ width, height: 6, background: "rgba(255,255,255,0.15)" }}>
          <div style={{ width: `${p * 100}%`, height: 6, background: GRAPHICS_GRADIENT }} />
        </div>
      </div>
    );
  }

  return (
    <div style={style}>
      {lines.map((line, i) => (
        <div
          key={`${item.spec.id}-line-${i}`}
          style={{
            fontWeight: item.spec.kind === "title" ? 700 : 600,
            lineHeight: 1.1,
            letterSpacing: item.spec.kind === "kicker" ? 6 : 0.5,
            textTransform: item.spec.kind === "kicker" ? "uppercase" : undefined,
            textShadow: "0 4px 30px rgba(0,0,0,0.55)",
          }}
        >
          {line}
        </div>
      ))}
      {item.spec.subtext ? (
        <div style={{ marginTop: 10, fontWeight: 500, fontSize: item.fontSizeScaled * 0.55, opacity: 0.85 }}>
          {item.spec.subtext}
        </div>
      ) : null}
      {item.spec.kind === "overlay" && item.spec.panel ? (
        <div
          style={{
            background: "rgba(13,17,23,0.86)",
            border: "1px solid rgba(255,255,255,0.08)",
            borderRadius: GRAPHICS_RADIUS.panel,
            boxShadow: GRAPHICS_SHADOW.card,
            padding: "28px 36px",
            maxWidth: frameSize.width - 200,
          }}
        >
          {item.spec.panel.title ? (
            <div style={{ fontWeight: 700, marginBottom: 10 }}>{item.spec.panel.title}</div>
          ) : null}
          {item.spec.panel.body ? <div style={{ fontWeight: 400, opacity: 0.88 }}>{item.spec.panel.body}</div> : null}
        </div>
      ) : null}
    </div>
  );
};

/** Full graphics stack mounted over footage for one frame range. */
export const GraphicsLayer: React.FC<{
  items: ResolvedGraphicsItem[];
  frameSize?: FrameSize;
  safeArea?: SafeArea;
}> = ({ items, frameSize = DEFAULT_FRAME, safeArea = DEFAULT_SAFE_AREA }) => {
  const frame = useCurrentFrame();
  const visible = items.filter((it) => frame >= it.range.frameFrom && frame < it.range.frameTo);
  return (
    <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
      {visible.map((it) => (
        <GraphicsItemView key={it.spec.id} item={it} frameSize={frameSize} safeArea={safeArea} />
      ))}
    </div>
  );
};

/** Credit roll view: deterministic scroll from ../credits. */
export const CreditsView: React.FC<{ spec: CreditsTimeline; frameSize?: FrameSize }> = ({
  spec,
  frameSize = DEFAULT_FRAME,
}) => {
  const frame = useCurrentFrame();
  const layout = creditsScrollAt(frame, spec, frameSize);
  const scale = frameSize.width / 1080;
  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden", zIndex: 50, pointerEvents: "none" }}>
      <div style={{ transform: `translateY(${layout.scrollY}px)` }}>
        {spec.title ? (
          <div
            style={{
              height: 200 * scale,
              display: "flex",
              alignItems: "flex-end",
              justifyContent: "center",
              fontFamily: GRAPHICS_FONTS.display,
              fontSize: 64 * scale,
              fontWeight: 700,
              color: "#ffffff",
            }}
          >
            {spec.title}
          </div>
        ) : null}
        {spec.rows.map((row, i) => (
          <div
            key={`credit-row-${i}`}
            style={{
              height: 120 * scale,
              marginBottom: 24 * scale,
              textAlign: "center",
              fontFamily: GRAPHICS_FONTS.body,
            }}
          >
            <div style={{ fontSize: 28 * scale, letterSpacing: 4, color: "#8b949e", textTransform: "uppercase" }}>
              {row.role}
            </div>
            <div style={{ fontSize: 44 * scale, fontWeight: 600, color: "#ffffff" }}>{row.names.join(" · ")}</div>
          </div>
        ))}
      </div>
    </div>
  );
};

/** Convenience: compose + mount from raw plan data in one component. */
export const ComposedGraphicsLayer: React.FC<{
  items: Parameters<typeof composeGraphics>[0]["items"];
  shots?: Parameters<typeof composeGraphics>[0]["shots"];
  frameSize?: FrameSize;
  safeArea?: SafeArea;
  credits?: CreditsTimeline;
}> = ({ items, shots, frameSize = DEFAULT_FRAME, safeArea = DEFAULT_SAFE_AREA, credits }) => {
  const stack: GraphicsStack = composeGraphics({ items, shots, frame: frameSize, safeArea });
  return (
    <>
      <GraphicsLayer items={stack.items} frameSize={frameSize} safeArea={safeArea} />
      {credits ? <CreditsView spec={credits} frameSize={frameSize} /> : null}
    </>
  );
};

/** Silence unused-import lint for config hook parity with upstream shots. */
export const useGraphicsFrame = (): { frame: number; fps: number } => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return { frame, fps };
};