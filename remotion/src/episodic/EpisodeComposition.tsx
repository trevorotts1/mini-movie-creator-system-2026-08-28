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
}> = ({ config, fps }) => {
  return (
    <>
      {config.shots.map((shot) => (
        <EpisodeShot key={shot.shotId} config={shot} fps={fps} />
      ))}
    </>
  );
};

export const EpisodeShot: React.FC<{
  config: ShotCompositionConfig;
  fps: number;
}> = ({ config, fps }) => {
  return (
    <AbsoluteFill style={{ backgroundColor: '#101014' }}>
      {/* Placeholder shot surface — layer components (VID-004..009) mount here. */}
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
    </AbsoluteFill>
  );
};

export const EpisodeComposition: React.FC<{
  config: EpisodeCompositionConfig;
}> = ({ config }) => {
  return (
    <AbsoluteFill>
      {config.scenes.map((scene) => (
        <EpisodeScene key={scene.sceneId} config={scene} fps={config.fps} />
      ))}
    </AbsoluteFill>
  );
};