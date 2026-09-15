// Barrel — packages/remotion-runtime/src/final-render/ (VID-014, SKR-004).
export * from "./contract.js";
export * from "./upscale.js";
export * from "./pipeline.js";
export * from "./cli.js";
export * from "./ffprobe-fixture.js";
// SKR-004 — the genuine Remotion render path (bundle → selectComposition →
// renderMedia). The ffmpeg adapters above stay exported for tests only.
export * from "./remotion-renderer.js";
// The bridge that lets the pipeline above actually use that adapter.
export * from "./pipeline-adapter.js";
