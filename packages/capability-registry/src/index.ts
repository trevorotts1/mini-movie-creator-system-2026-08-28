export const MMCS_CAPABILITY_REGISTRY = "@mmcs/capability-registry scaffold marker";

export * from "./llm-registry/index.js";
// CAP-010 observed-overrides: re-exported as a namespace — `ObservationKind`,
// `RuntimeObservation`, and `ObservedOverride` are also defined by CAP-009's
// verify module (bare star-export would be TS2308 ambiguous). CAP-009 keeps
// the bare names; CAP-010's full contract stays reachable as
// `ObservedOverrides.*` so neither side's exports are dropped.
export * as ObservedOverrides from "./observed-overrides/index.js";
export * from "./schema/index.js";
export * from "./validators/reference-count.js";
export * from "./verify/index.js";
