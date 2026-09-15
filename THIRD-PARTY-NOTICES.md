# Third-party notices

This project is MIT licensed (see `LICENSE`). It depends on third-party software whose
licence terms differ, and it bundles some of that software into rendered output paths.
This file records what is actually present, verified against the installed artefacts rather
than copied from upstream documentation.

**This is a factual inventory, not legal advice.**

## FFmpeg, bundled in the Remotion compositor

`@remotion/renderer` installs a per-platform binary package (`@remotion/compositor-<platform>`)
which contains `ffmpeg`, `ffprobe` and their shared libraries. Those binaries are **not**
covered by this project's MIT licence.

Verified configuration of `@remotion/compositor-darwin-arm64@4.0.518`
(`ffmpeg version n7.1`, Copyright (c) 2000-2024 the FFmpeg developers):

- `--enable-gpl` **is** present.
- `--enable-nonfree` is **absent**. The binary therefore does not carry the flag that would
  make an FFmpeg build undistributable.
- `--enable-libfdk-aac` **is** present.
- Running `ffmpeg -L` reports the **GNU General Public License, version 2 or later**.

Reproduce (the binary will not run by bare path — its dylibs use relative install names, so
it must be run from its own directory):

```sh
cd remotion/node_modules/@remotion/compositor-darwin-arm64
DYLD_LIBRARY_PATH="$PWD" ./ffmpeg -version
DYLD_LIBRARY_PATH="$PWD" ./ffmpeg -L
```

### Consequences

- **GPL v2 obligations attach.** Distributing this software together with those binaries
  means the FFmpeg components remain GPL v2. That carries source-availability and notice
  obligations; it is not a prohibition on distribution.
- **The FDK AAC library is compiled in.** The Fraunhofer FDK AAC licence is generally held
  to be incompatible with the GPL, which is why FFmpeg normally gates that library behind
  `--enable-nonfree`. This build shows the library enabled, no `--enable-nonfree`, and a
  GPL v2 banner. **This specific interaction has not been resolved here** and should be
  reviewed by someone able to read FFmpeg's `configure` for this revision. It is recorded
  rather than concluded, because reaching a licence conclusion by pattern-matching a build
  string is how you get it wrong in both directions.

## The compositor packages declare no licence

`@remotion/compositor-*` ships no `license` field in its `package.json`. That is an upstream
gap, not something this repository can correct; it is recorded here so it is not mistaken
for an oversight in this project.

## Remotion itself

`remotion` and the `@remotion/*` family are consumed under Remotion's own licence terms. See
the `remotion` package for its licence. Note that Remotion's licence is not MIT and has
conditions that apply to for-profit use above a size threshold — check it before commercial
distribution.

## Fonts

Compositions load five Google Fonts (Space Grotesk, Inter, JetBrains Mono, Spectral, Source
Serif 4) through `@remotion/google-fonts`. These are fetched at render time and are licensed
under the SIL Open Font License. The font files themselves are not vendored into this
repository.

## Maintaining this file

Every claim above was verified by running the tool named in it. If you change the pinned
Remotion version, re-run the commands in this file — the FFmpeg configuration is a property
of the pinned binary and will change with it.
