/// <reference types="node" />
// Genuine Remotion render adapter (SKR-004) — the production render path.
//
// WHY this module exists: before it, `@mmcs/remotion-runtime` declared only
// `react`, `react-dom` and `remotion` (the *composition* library, which cannot
// render anything by itself) and its only adapter shelled ffmpeg for a
// `testsrc2` test pattern. A test pattern is not a render: nothing ever
// bundled a composition, so the rough cut passed the literal string
// `"rough-cut://fixture"` as its `serveUrl` — a fake URL standing in for a
// bundle that was never produced. This adapter performs the real upstream
// `remotion/scripts/render-all.mjs` sequence:
//
//   bundle(entryPoint) → selectComposition(serveUrl, id) → renderMedia(...)
//
// The Remotion family must be ONE version across the family, so
// `@remotion/bundler` and `@remotion/renderer` are declared at the same
// resolved version as `remotion` in package.json.
//
// WHY the collaborators arrive as injected, structurally-typed ports:
// `@remotion/renderer` downloads and drives a ~190 MB headless Chrome on
// first use, so a render cannot run in a unit test, and the package must stay
// importable (and typecheckable) on a host where the renderer is not yet
// installed. Tests inject fakes; production injects the real dynamic import;
// both satisfy the same three-call type surface declared below. The seam is
// also what makes drift in the Remotion API loud: the shape here is the
// documented `bundle`/`selectComposition`/`renderMedia` input contract, and a
// mismatch is a type error at the injection site, not a silent bad render.
//
// The ffmpeg adapters (`makeFfmpegFixtureAdapter` in this directory and in
// `../rough-cut/render.ts`) remain available for tests ONLY — they synthesize
// a test pattern and are NOT a render path.

/** One `staticFile()`-rooted asset directory for the bundle (upstream: `media/`). */
export interface RemotionRenderRequest {
  /** Composition id registered inside the bundle, e.g. `S01E01`. */
  compositionId: string;
  /**
   * Remotion bundle entry (the file calling `registerRoot`) or a pre-built
   * serve URL. Resolution order: this field → adapter `entryPoint` option →
   * `MMCS_REMOTION_ENTRY`.
   */
  entryPoint?: string;
  /** Deterministic absolute output path the render writes. */
  output: string;
  fps: number;
  width: number;
  height: number;
  durationInFrames: number;
  codec: "h264";
  /**
   * `staticFile()` public root (upstream: `Config.setPublicDir('<repo>/media')`).
   * The programmatic `bundle()` API ignores remotion.config.ts, so it must be
   * passed explicitly or every `staticFile()` reference 404s in the browser.
   */
  publicDir?: string;
  /** Render scale — 1 = native composition resolution (spec: never fake 4K). */
  scale?: number;
  imageFormat?: "jpeg" | "png";
  crf?: number;
  pixelFormat?: "yuv420p" | "yuva444p10le";
  /** Overwrite an existing output file (deterministic re-renders). */
  overwrite?: boolean;
}

export interface RemotionRenderResult {
  output: string;
  renderSeconds: number;
}

export type RemotionRenderAdapter = (
  request: RemotionRenderRequest,
) => Promise<RemotionRenderResult>;

/** Input contract of `bundle()` from `@remotion/bundler`. */
export interface RemotionBundleInput {
  entryPoint: string;
  publicDir?: string;
  onProgress?: (progress: number) => void;
}

export type RemotionBundler = (
  input: RemotionBundleInput,
) => Promise<string>;

/**
 * The composition metadata `selectComposition()` returns. Declared
 * structurally (intersected with a pass-through record) so the real value —
 * which carries width/height/fps/durationInFrames plus props — is accepted
 * without this package re-declaring Remotion's whole type surface. The
 * `durationInFrames` here is deliberately NOT trusted: the caller's requested
 * duration is authoritative (see {@link makeRemotionRenderAdapter}).
 */
export type RemotionSelectedComposition = {
  durationInFrames: number;
} & Record<string, unknown>;

export type RemotionCompositionSelector = (input: {
  serveUrl: string;
  id: string;
  inputProps?: Record<string, unknown>;
}) => Promise<RemotionSelectedComposition>;

/** Input contract of `renderMedia()` from `@remotion/renderer` (subset used). */
export interface RemotionRenderMediaInput {
  serveUrl: string;
  composition: RemotionSelectedComposition;
  outputLocation: string;
  overwrite?: boolean;
  codec?: string;
  scale?: number;
  imageFormat?: string;
  crf?: number;
  pixelFormat?: string;
  onProgress?: (progress: { progress: number }) => void;
}

export type RemotionMediaRenderer = (
  input: RemotionRenderMediaInput,
) => Promise<unknown>;

/** The three Remotion calls the adapter drives — the whole injected surface. */
export interface RemotionRendererModules {
  bundle: RemotionBundler;
  selectComposition: RemotionCompositionSelector;
  renderMedia: RemotionMediaRenderer;
}

export interface RemotionRenderAdapterOptions {
  /**
   * Bundle entry point. Resolution order per render: request.entryPoint →
   * this → `MMCS_REMOTION_ENTRY` → a named error (never a silent test pattern).
   */
  entryPoint?: string;
  publicDir?: string;
  scale?: number;
  imageFormat?: "jpeg" | "png";
  crf?: number;
  pixelFormat?: "yuv420p" | "yuva444p10le";
  /** Called once per new bundle with the serve URL (progress/log seam). */
  onBundle?: (serveUrl: string, entryPoint: string) => void;
  /** Render progress (0..1), forwarded from Remotion. */
  onProgress?: (progress: number) => void;
  /**
   * Test/doctor seam: overrides {@link loadRemotionRenderer}, so the adapter
   * can be exercised end-to-end without a browser download.
   */
  loadModules?: () => Promise<RemotionRendererModules>;
}

/** Stable error code for a missing/unusable render bundle entry point. */
export const REMOTION_ENTRY_POINT_ERROR = "REMOTION_ENTRY_POINT_MISSING";

/**
 * Resolve the bundle entry point or fail loudly.
 *
 * Guessing a default here would silently render the wrong entry (or nothing),
 * which is exactly the defect this adapter replaces, so an unset entry point
 * is a named, actionable error naming both the option and the env var.
 */
export function resolveRemotionEntryPoint(
  request: Pick<RemotionRenderRequest, "entryPoint" | "compositionId">,
  options: RemotionRenderAdapterOptions = {},
): string {
  const entryPoint =
    request.entryPoint?.trim() ||
    options.entryPoint?.trim() ||
    process.env.MMCS_REMOTION_ENTRY?.trim();
  if (!entryPoint) {
    throw new Error(
      `${REMOTION_ENTRY_POINT_ERROR}: no Remotion bundle entry point for composition ` +
        `'${request.compositionId}' — pass the adapter option 'entryPoint', the request ` +
        `field 'entryPoint', or set MMCS_REMOTION_ENTRY to the file that calls registerRoot() ` +
        `(upstream: remotion/src/index.ts)`,
    );
  }
  return entryPoint;
}

/**
 * Lazy `import()` of the real `@remotion/bundler` + `@remotion/renderer`.
 *
 * WHY lazy and resolved from an explicit path: both are declared dependencies
 * of this package, but they are heavy (the renderer downloads headless Chrome)
 * and the module specifiers are resolved at call time from the *adapter's*
 * location, so importing the package never pulls a browser into a process that
 * only assembles a timeline. The two errors are distinguished deliberately: an
 * unresolvable specifier means the install step never ran, while a module that
 * loads but lacks a function means a version drift inside the Remotion family.
 */
export async function loadRemotionRenderer(): Promise<RemotionRendererModules> {
  const [bundler, renderer] = await Promise.all([
    importSibling("@remotion/bundler"),
    importSibling("@remotion/renderer"),
  ]);
  // A module that resolves but lacks the call we need means the Remotion
  // family versions drifted apart — say so instead of failing as "undefined
  // is not a function" halfway through a production render.
  const bundle = requireCall<RemotionBundler>(
    "@remotion/bundler#bundle",
    bundler.bundle,
  );
  const selectComposition = requireCall<RemotionCompositionSelector>(
    "@remotion/renderer#selectComposition",
    renderer.selectComposition,
  );
  const renderMedia = requireCall<RemotionMediaRenderer>(
    "@remotion/renderer#renderMedia",
    renderer.renderMedia,
  );
  return { bundle, selectComposition, renderMedia };
}

/** Narrow an imported export to its call signature, or name the drift. */
function requireCall<T>(name: string, value: unknown): T {
  if (typeof value !== "function") {
    throw new Error(
      `Remotion module '${name}' is missing — every @remotion/* package must resolve ` +
        `to the same 4.x version as 'remotion' (check pnpm-lock and the install tree)`,
    );
  }
  return value as T;
}

/** One lazy import per Remotion entry point, with a diagnostic that names the fix. */
async function importSibling(specifier: string): Promise<Record<string, unknown>> {
  try {
    // WHY the specifier goes through a runtime value instead of a literal:
    // `@remotion/renderer` and `@remotion/bundler` are declared dependencies,
    // but a checkout that has not run `pnpm install` yet has no declaration
    // files for them. A literal specifier would make that checkout fail to
    // TYPE CHECK for a reason that has nothing to do with this code, so the
    // import is deliberately dynamic — resolution stays anchored to this
    // module's location at call time, and the missing-dependency case is
    // reported by loadRemotionRenderer() with the install instruction.
    const target: string = specifier;
    return (await import(target)) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `Remotion renderer unavailable: '${specifier}' could not be loaded ` +
        `(${err instanceof Error ? err.message : String(err)}). Run 'pnpm install' in the ` +
        `workspace root; the first render also downloads a headless Chrome browser.`,
    );
  }
}

/**
 * GENUINE render adapter — bundles a Remotion composition and renders it with
 * `@remotion/renderer`. This is the production `RenderAdapter` /
 * `RoughCutRenderAdapter`; the ffmpeg fixture adapters are test-only.
 *
 * Bundling is cached per entry point + public dir: `bundle()` runs webpack
 * over the whole composition tree (seconds to minutes), so a render batch
 * pays it once — the same "bundle once, render the manifest" posture as
 * upstream `render-all.mjs`. Bundle failures are never cached, so a transient
 * failure does not poison every later render.
 *
 * The caller's `durationInFrames` overrides the composition's own duration, so
 * a partial render (preview range, exact frame math) renders exactly the
 * requested range. `codec: "h264"` + `yuv420p` is the spec's master output.
 */
export function makeRemotionRenderAdapter(
  options: RemotionRenderAdapterOptions = {},
): RemotionRenderAdapter {
  /** serveUrl cache keyed by `entryPoint\u0000publicDir`. */
  const bundles = new Map<string, Promise<string>>();

  const loadModules = options.loadModules ?? loadRemotionRenderer;

  return async (request: RemotionRenderRequest): Promise<RemotionRenderResult> => {
    const started = Date.now();
    const entryPoint = resolveRemotionEntryPoint(request, options);
    const publicDir = request.publicDir ?? options.publicDir;
    const modules = await loadModules();

    const cacheKey = `${entryPoint}\u0000${publicDir ?? ""}`;
    let bundled = bundles.get(cacheKey);
    if (!bundled) {
      bundled = modules
        .bundle({ entryPoint, publicDir })
        .then((serveUrl) => {
          if (typeof serveUrl !== "string" || serveUrl.length === 0) {
            throw new Error(
              `bundle() returned no serve URL for entry point '${entryPoint}'`,
            );
          }
          options.onBundle?.(serveUrl, entryPoint);
          return serveUrl;
        })
        .catch((err: unknown) => {
          // A failed bundle must not be memoized: drop it so the next render
          // retries instead of replaying a stale rejection forever.
          bundles.delete(cacheKey);
          throw err;
        });
      bundles.set(cacheKey, bundled);
    }
    const serveUrl = await bundled;

    const selected = await modules.selectComposition({
      serveUrl,
      id: request.compositionId,
    });
    if (selected === null || typeof selected !== "object") {
      throw new Error(
        `selectComposition('${request.compositionId}') returned no composition — ` +
          `is the composition registered in the bundle at ${entryPoint}?`,
      );
    }

    await modules.renderMedia({
      serveUrl,
      // Caller duration wins over the composition's own durationInFrames.
      composition: { ...selected, durationInFrames: request.durationInFrames },
      outputLocation: request.output,
      overwrite: request.overwrite ?? true,
      codec: request.codec,
      scale: request.scale ?? options.scale ?? 1,
      ...(request.imageFormat ?? options.imageFormat
        ? { imageFormat: request.imageFormat ?? options.imageFormat }
        : {}),
      ...(request.crf ?? options.crf ? { crf: request.crf ?? options.crf } : {}),
      ...(request.pixelFormat ?? options.pixelFormat
        ? { pixelFormat: request.pixelFormat ?? options.pixelFormat }
        : {}),
      ...(options.onProgress
        ? { onProgress: ({ progress }: { progress: number }) => options.onProgress?.(progress) }
        : {}),
    });

    return { output: request.output, renderSeconds: (Date.now() - started) / 1000 };
  };
}

/**
 * True when the Remotion renderer can actually be loaded in this process.
 *
 * Exposed for readiness checks (`mmcs doctor`-style surfaces) so a host that
 * has not run `pnpm install` reports "renderer unavailable" up front instead
 * of failing halfway through a production render.
 */
export async function remotionRendererAvailable(
  options: Pick<RemotionRenderAdapterOptions, "loadModules"> = {},
): Promise<boolean> {
  try {
    await (options.loadModules ?? loadRemotionRenderer)();
    return true;
  } catch {
    return false;
  }
}
