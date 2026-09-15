/**
 * Bridge between the final-render pipeline and the Remotion render adapter.
 *
 * The two were written against different vocabularies and nothing connected
 * them:
 *
 *   pipeline  RenderRequest   { resolution: { width, height }, durationSeconds, scale }
 *   adapter   RemotionRenderRequest { width, height, durationInFrames, scale? }
 *
 * Because no conversion existed anywhere in the tree, the adapter — the thing
 * the pipeline is supposed to render through — was unreachable from it. Any
 * caller wiring the two together had to know both shapes, and getting it wrong
 * failed at render time rather than at the type level. This is that conversion,
 * in one place, so both sides can be type-checked against each other.
 *
 * Nothing here fabricates an entry point: if neither the request nor the
 * adapter options supply one, `makeRemotionRenderAdapter` raises
 * REMOTION_ENTRY_POINT_MISSING rather than silently rendering a fixture.
 */
import {
  makeRemotionRenderAdapter,
  type RemotionRenderAdapterOptions,
  type RemotionRenderRequest,
} from "./remotion-renderer.js";
import type { RenderRequest, RenderResult } from "./pipeline.js";

/**
 * Convert a pipeline render request into the adapter's request shape.
 *
 * `durationSeconds` becomes whole frames: Remotion rejects a fractional
 * `durationInFrames`, and truncating would silently shorten the episode, so the
 * value is rounded and floored at one frame.
 */
export function toRemotionRenderRequest(request: RenderRequest): RemotionRenderRequest {
  return {
    compositionId: request.compositionId,
    output: request.output,
    fps: request.fps,
    width: request.resolution.width,
    height: request.resolution.height,
    durationInFrames: Math.max(1, Math.round(request.durationSeconds * request.fps)),
    codec: request.codec,
    scale: request.scale,
    ...(request.entryPoint === undefined ? {} : { entryPoint: request.entryPoint }),
    ...(request.publicDir === undefined ? {} : { publicDir: request.publicDir }),
  };
}

/**
 * The pipeline's `ports.render`, backed by the real Remotion adapter.
 *
 * Pass the result as `FinalRenderPorts.render`. The adapter options carry the
 * bundle entry point, public dir and progress/log seams.
 */
export function makePipelineRenderPort(
  options: RemotionRenderAdapterOptions = {},
): (request: RenderRequest) => Promise<RenderResult> {
  const adapter = makeRemotionRenderAdapter(options);
  return (request: RenderRequest): Promise<RenderResult> =>
    adapter(toRemotionRenderRequest(request));
}
