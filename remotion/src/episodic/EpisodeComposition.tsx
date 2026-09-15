import React from 'react';
import { AbsoluteFill } from 'remotion';
import type {
  EpisodeCompositionConfig,
  SceneCompositionConfig,
  ShotCompositionConfig,
} from './types';

/**
 * Episodic composition host (spec §21 — episodic timeline).
 *
 * The registry generator (scripts/gen-registry.mjs) resolves a DB-derived
 * plan into one <Composition> per episode and writes episode-registry.gen.ts.
 * Each episode renders through this component: scenes and shots are placed by
 * their cumulative `sequenceFrom` frame offsets, so the frame-QA conversion
 * `local_f = global_s * fps − sequence_from` (scripts/frames.mjs) stays exact.
 *
 * Layer rendering is intentionally delegated: layer components (dialogue,
 * ai-video, still-motion, stock, graphics, transitions — VID-004..009) mount
 * inside each shot's Sequence. This host only owns episodic placement and
 * metadata so the registry can compile before those layers land.
 */

export const EpisodeScene: React.FC<{
  config: SceneCompositionConfig;
  fps: number;
  showDebug?: boolean;
}> = ({ config, fps, showDebug = false }) => {
  return (
    <>
      {config.shots.map((shot) => (
        <EpisodeShot key={shot.shotId} config={shot} fps={fps} showDebug={showDebug} />
      ))}
    </>
  );
};

export const EpisodeShot: React.FC<{
  config: ShotCompositionConfig;
  fps: number;
  /**
   * Renders the shot-identifying debug overlay. Defaults to FALSE, and that default is the
   * fix for SKR-009: this overlay used to render unconditionally, so every episodic render
   * — including a real, paid one — came out with a shot label burned into the picture
   * ("S01E01-S01 · shot 1 · 90f @ 30fps"). Debug text must be opt-in, never the default.
   */
  showDebug?: boolean;
}> = ({ config, fps, showDebug = false }) => {
  return (
    <AbsoluteFill style={{ backgroundColor: '#101014' }}>
      {/* Placeholder shot surface — layer components (VID-004..009) mount here. */}
      {showDebug ? (
        <div
          style={{
            position: 'absolute',
            left: 24,
            top: 24,
            fontFamily: 'sans-serif',
            fontSize: 18,
            color: 'rgba(255,255,255,0.72)',
          }}
        >
          {config.shotId} · shot {config.sequenceIndex} · {config.durationInFrames}f @ {fps}fps
        </div>
      ) : null}
    </AbsoluteFill>
  );
};

export const EpisodeComposition: React.FC<{
  config: EpisodeCompositionConfig;
}> = ({ config }) => {
  return (
    <AbsoluteFill>
      {config.scenes.map((scene) => (
        <EpisodeScene
          key={scene.sceneId}
          config={scene}
          fps={config.fps}
          // Only a placeholder registry turns this on — see EpisodeShot.showDebug.
          showDebug={config.placeholder === true}
        />
      ))}
    </AbsoluteFill>
  );
};