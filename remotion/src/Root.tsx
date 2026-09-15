import React from 'react';
import { Composition } from 'remotion';
import { shots } from './registry.gen';
import { EpisodeComposition } from './episodic/EpisodeComposition';
import { episodeCompositions } from './episodic/episode-registry.gen';

/** Props host for an episodic composition: the config is data, not children. */
const EpisodeHost: React.FC<{ config: (typeof episodeCompositions)[number] }> = ({
  config,
}) => <EpisodeComposition config={config} />;

// Every shot file exports `compositionConfig` + a default component. gen-registry.mjs
// discovers them into registry.gen. This maps each to a <Composition>.
//
// The EPISODIC compositions are registered here too. They were previously
// omitted from the production bundle entirely — only the regression smoke's own
// generated entry imported episode-registry.gen — so `selectComposition({
// id: 'S01E01' })` failed against the real bundle and `mmcs final` could never
// have rendered an episode even with the render chain wired. The smoke proved
// the renderer worked; it could not prove the production entry was usable.
export const RemotionRoot: React.FC = () => {
  return (
    <>
      {shots.map(({ Comp, config }) => (
        <Composition
          key={config.id}
          id={config.id}
          component={Comp as React.FC}
          durationInFrames={Math.max(1, Math.round(config.durationInSeconds * config.fps))}
          fps={config.fps}
          width={config.width}
          height={config.height}
        />
      ))}
      {episodeCompositions.map((config) => (
        <Composition
          key={config.compositionId}
          id={config.compositionId}
          component={EpisodeHost as React.FC}
          durationInFrames={config.durationInFrames}
          fps={config.fps}
          width={config.width}
          height={config.height}
          defaultProps={{ config }}
        />
      ))}
    </>
  );
};
