# MMCS Architecture — Package Map

Monorepo layout (spec.md §1, §55). pnpm workspaces; packages under `packages/`,
apps under `apps/`, third-party/system integration surfaces under `integrations/`.

## Packages

| Package | Role |
|---|---|
| `@mmcs/domain` | Pure domain model: projects, series, episodes, scenes, shots, characters, approvals, QC results, costs. No I/O, no dependencies. |
| `@mmcs/core` | Engine orchestration: pipeline state machine, approval gates, checkpointing. Depends on `domain`; owns interfaces (`MediaStore`, provider ports, repositories). |
| `@mmcs/database` | Durable state (SQLite first, PostgreSQL-ready repositories per spec §25). Implements core's repository interfaces. |
| `@mmcs/providers` | Provider adapters (Agnes, Kie, Fish, ElevenLabs, Gemini, fal). Implements core's provider ports. Reads `capability-registry`. |
| `@mmcs/capability-registry` | Machine-readable provider capability records (configured / documented / verified). Pure data + validation. |
| `@mmcs/prompt-compilers` | Compile story/script/shot data into provider prompts. Pure functions over `domain` types. |
| `@mmcs/scene-intelligence` | Scene/shot planning intelligence (beats, continuity, reference packs). |
| `@mmcs/character-library` | Character versions, canon, continuity enforcement. |
| `@mmcs/media-storage` | Asset storage. **Behind the `MediaStore` interface** — backends (local, GHL) plug in; callers never touch a backend directly. |
| `@mmcs/qc` | QC passes over generated assets; verdicts feed the pipeline. |
| `@mmcs/cost-engine` | Estimates, spend tracking, budget gates (spec §24 `estimate`, cost controls). |
| `@mmcs/remotion-runtime` | Bridge package to rendering. The upstream `remotion/` directory stays untouched as the inherited renderer; this package is the only seam MMCS packages use to drive it. |

## Apps

| App | Role |
|---|---|
| `@mmcs/cli` | The `mmcs` CLI (spec §24 command surface). Thin layer over `core` — no business logic. |
| `@mmcs/api` | Thin HTTP service boundary exposing the same operations as the CLI (spec §24/§59). |
| `@mmcs/web` | Reserved (`.gitkeep` only). |

## Integrations

| Dir | Role |
|---|---|
| `integrations/openclaw` | OpenClaw/skill-calling surface (reserved). |
| `integrations/claude` | Claude Code/skill surface (reserved). |

## Dependency direction (binding)

```text
            ┌────────────────────────────────────────────┐
            │                @mmcs/domain                │  (depends on nothing)
            └────────────────────────────────────────────┘
                                ▲
            ┌────────────────────────────────────────────┐
            │                 @mmcs/core                 │  (owns interfaces)
            └────────────────────────────────────────────┘
                                ▲
      ┌─────────────┬───────────┼──────────────┬──────────────────┐
 @mmcs/database @mmcs/providers @mmcs/media-storage @mmcs/remotion-runtime  @mmcs/cli
      (adapters)   (adapters)      (adapters)           (adapter)          (apps/*)
```

Rules (spec §55 — split shared seams behind interfaces):

1. **domain ← core ← adapters.** `domain` imports nothing. `core` imports only
   `domain`. Adapter packages (`database`, `providers`, `media-storage`,
   `remotion-runtime`) import `core` (for interfaces) and `domain` (for types).
2. **Adapters never import adapters.** No cross-imports between `database`,
   `providers`, `media-storage`, `remotion-runtime`. Composition happens in `core`
   or in the app layer.
3. **`capability-registry` is imported by `providers`** (and may be read by `core`
   for verification flows). It never imports adapter packages.
4. **`media-storage` sits behind the `MediaStore` interface** owned by `core`;
   consumers depend on the interface, never on the package.
5. **`packages/remotion-runtime` is the bridge.** The upstream `remotion/` source
   tree is preserved untouched; nothing in `packages/` or `apps/` imports it
   directly.
6. `cli`/`api` import `core` only (plus `domain` types). Feature packages
   (`prompt-compilers`, `scene-intelligence`, `character-library`, `qc`,
   `cost-engine`) import `domain` and `core` interfaces; they are consumed by
   `core`/apps, never by adapters.

## Build & test

- `pnpm install` (workspace root; corepack provides pnpm)
- `pnpm -r build` / `pnpm -r test` / `pnpm -r typecheck`
- Tests: vitest (`vitest.config.ts` at root). Remotion checks remain
  `npm run gen` + `npx tsc --noEmit` inside `remotion/` (upstream, untouched).