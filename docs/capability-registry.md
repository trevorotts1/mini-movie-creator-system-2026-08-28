# Model Capability Registry

Every planning, validation, and cost decision that depends on what a model
can do reads the **capability registry** — never a hard-coded constant inside
an adapter, never a number invented at call time.

## Where it lives

- Machine-readable data: `packages/capability-registry/src/data/`
  (`agnes.ts`, `kie.ts`, `fish.ts`, `reasoning.ts`) with a schema in
  `../schema` and validators in `../validators`.
- Registry package surface: `packages/capability-registry/src/index.ts`
  (LLM registry, pricing, max-reasoning, observed-override layers).
- Human-readable twin: `docs/provider-capabilities/` — one file per provider
  family (agnes, kie, fish-audio, ghl, reasoning-models), every value carrying
  the provenance triple `lastVerifiedAt` + `sourceUrls` + `confidence`.

## Confidence meanings (docs/provider-capabilities/README.md)

- **VERIFIED** — read from the provider's own live docs on `lastVerifiedAt`.
- **PROVISIONAL** — from an authoritative router catalog (e.g. OpenRouter
  model API), not the vendor's own docs; re-verify at adapter build.
- **UNKNOWN** — the provider does not state the value; the registry keeps
  `null` plus a notes entry. **UNKNOWN IS VALID.** A test asserts the Agnes
  prompt-character ceiling stays UNKNOWN — never fill a null with an invented
  value.

## What the registry gates at runtime

Per-shot planning validates **before** any provider call (spec §15 image
registry / video equivalents): prompt character limits, reference-image
counts, identity/reference support, image-to-image, aspect ratios,
resolutions, output counts, seed support, file limits, cost/quota. Keyframe
strategy (0/1/2 keyframes vs multimodal reference package) is validated against
the selected model's profile. UNKNOWN limits surface as UNKNOWN — preserved,
never guessed.

## Inspecting it

```bash
mmcs models            # registry view used by planning/validation
mmcs providers verify  # configured vs documented vs observed + last verified + warnings
```

`mmcs providers verify` reports the runbook §61 triple (configured,
documented, runtime-observed where safely testable) and **never silently
rewrites a VERIFIED capability** because of one transient probe failure.
Observed divergences land in the observed-override layer
(`packages/capability-registry/src/observed-overrides/`) with provenance, not
into the documented values.

## Maintenance rule

Re-verify every source URL before changing a number; promotional pricing is
stored as `pricingDetail` entries with list prices attached. Full rule:
`docs/provider-capabilities/README.md`. Adding a new provider family:
`docs/adding-a-provider.md`.