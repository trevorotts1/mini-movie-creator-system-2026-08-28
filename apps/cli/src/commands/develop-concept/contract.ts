// Concept-gate CLI contract — `mmcs develop-concept` + `mmcs approve concept`
// (spec §24 verbs, spec §3 gate 1; runbook §24 DIR-003).
//
// Owns only this directory (apps/cli/src/commands/develop-concept/). The two
// verbs wire over the CORE-011 stubs via CommandSpec overrides merged at
// integration (apps/cli/src/dispatch/registry.ts — mergeSpecs; the same seam
// CHAR-004/VID-013/CORE-015 use).
//
// Handlers are thin: they parse documented options, run the PURE contract
// functions over injected ports (approval store, concept presenter), print
// result lines, and return the documented exit codes (0 success, 1 gate
// rejection / invalid input, 2 usage error). No process.exit — the dispatcher
// owns termination. No filesystem, no network, no provider spend here.
//
// SECURITY (spec §29): idea text and concept text are UNTRUSTED DATA. They
// are echoed to the operator verbatim as inert presentation content and are
// never executed, shell-interpolated, or re-interpreted as instructions.

/**
 * Command-spec shape for the CORE-011 dispatcher (mergeSpecs). Declared here,
 * not imported — the shape is identical to `apps/cli/src/dispatch/registry.ts`
 * `CommandSpec`, so the merge is structural (spec §55). Do not diverge.
 */
export interface CommandSpec {
  name: string;
  description: string;
  args?: string[];
  group: string;
}

export const CONCEPT_GROUP = "approvals";

export const DEVELOP_CONCEPT_SPEC: CommandSpec = {
  name: "develop-concept",
  description: "Develop a concept for approval (STOP at concept gate, spec §3)",
  group: CONCEPT_GROUP,
};

export const APPROVE_CONCEPT_SPEC: CommandSpec = {
  name: "approve concept",
  description: "Approve the developed concept (gate 1, spec §3)",
  group: CONCEPT_GROUP,
};

export const USAGE_DEVELOP_CONCEPT = [
  "Usage: mmcs develop-concept [--intake <idea_…>] [--model <vendor/model>] [--options <1-5>]",
  "",
  "Develops a concept from the captured idea and presents it at gate 1 (spec §3):",
  "the developed options are shown and the concept gate opens as PENDING.",
  "",
  "The command STOPS — no screenplay work happens until `mmcs approve concept`.",
].join("\n");

export const USAGE_APPROVE_CONCEPT = [
  "Usage: mmcs approve concept [--option <option_N>] [--by <operator>] [--note <text>]",
  "       mmcs approve concept --reject  [--by <operator>] [--note <text>]",
  "       mmcs approve concept --reopen  [--by <operator>] [--note <text>]",
  "",
  "Applies the operator's gate-1 decision to the developed concept (spec §3):",
  "  default            approve the concept (recommended option, or --option <id>)",
  "  --reject           send the concept back for revision (PENDING → REJECTED)",
  "  --reopen           present revised work again (APPROVED/REJECTED → PENDING)",
  "",
  "Screenplay work (`mmcs write-script`) refuses to run until the concept gate",
  "is APPROVED.",
].join("\n");

/** Concept draft handed to the decision flow (structural DIR-002 twin). */
export interface ConceptDraftLike {
  readonly conceptId: string;
  readonly intakeId: string;
  readonly options: readonly {
    readonly optionId: string;
    readonly title: string;
  }[];
  readonly recommendedOptionId: string;
}

/** What `develop-concept` needs from the engine around it (injected ports). */
export interface DevelopConceptPorts {
  /**
   * Run the concept development: produce the developed concept from the
   * current idea intake. Implementation lives with DIR-002's generator +
   * capability-gated director model; the CLI never sees credentials.
   */
  developConcept(): Promise<ConceptDraftLike>;
  /**
   * The durable approval-gate store (CORE-008 `ApprovalStore` satisfies this
   * structurally — the engine's gate-1 port from
   * packages/scene-intelligence/src/concept/approval/).
   */
  gates: {
    snapshot(gate: "concept"): Promise<{ state: string; approvedAt: string | null; decidedBy: string | null; note: string | null }>;
    approve(gate: "concept", decision?: { decidedBy?: string; note?: string }): Promise<{ state: string; approvedAt: string | null }>;
    reject(gate: "concept", decision?: { decidedBy?: string; note?: string }): Promise<{ state: string }>;
    reopen(gate: "concept", decision?: { decidedBy?: string; note?: string }): Promise<{ state: string }>;
  };
}

/** One CLI invocation's printed output + exit code (documented contract). */
export interface ConceptCommandResult {
  exitCode: 0 | 1 | 2;
  /** Lines the CLI prints (stdout on success, stderr on rejection). */
  output: string[];
}

/** Options parsed from one `develop-concept` invocation. */
export interface DevelopConceptOptions {
  readonly help: boolean;
}

/** Options parsed from one `approve concept` invocation. */
export interface ApproveConceptOptions {
  readonly help: boolean;
  /** Reject instead of approve (PENDING → REJECTED). */
  readonly reject: boolean;
  /** Reopen for revised work (APPROVED/REJECTED → PENDING). */
  readonly reopen: boolean;
  /** Explicit option selection; omitted = director model's recommendation. */
  readonly option: string | null;
  /** Operator identity recorded with the decision. */
  readonly by: string | null;
  /** Operator note recorded with the decision. */
  readonly note: string | null;
}

/**
 * Parse raw option values into the typed option set. Accepts either a plain
 * flag record or a commander Command-like instance (with `getOptionValue`) —
 * the shape the integration hands the handler when flags are registered on
 * the subcommand (same seam convention as CORE-015's backup commands).
 * Undocumented flags are ignored here; the dispatcher owns argv errors.
 */
export function parseApproveConceptOptions(
  raw: Record<string, unknown> | { getOptionValue: (k: string) => unknown },
): ApproveConceptOptions {
  const getValue = (raw as { getOptionValue?: (k: string) => unknown })
    .getOptionValue;
  const read = (flag: string): unknown =>
    typeof getValue === "function" ? getValue.call(raw, flag) : (raw as Record<string, unknown>)[flag];
  const asBool = (v: unknown): boolean => v === true;
  const asString = (v: unknown): string | null =>
    typeof v === "string" && v.trim().length > 0 ? v : null;
  return {
    help: asBool(read("help")),
    reject: asBool(read("reject")),
    reopen: asBool(read("reopen")),
    option: asString(read("option")),
    by: asString(read("by")),
    note: asString(read("note")),
  };
}

/**
 * Execute `mmcs develop-concept`: run development, present the options, open
 * the concept gate. Pure decision logic over injected ports — no process.exit,
 * no filesystem, no network of its own.
 */
export async function runDevelopConcept(
  ports: DevelopConceptPorts,
): Promise<ConceptCommandResult> {
  const draft = await ports.developConcept();
  const snapshot = await ports.gates.snapshot("concept");
  const lines = [
    `Developed concept ${draft.conceptId} from intake ${draft.intakeId} (gate 1, spec §3):`,
    "",
  ];
  for (const option of draft.options) {
    const marker = option.optionId === draft.recommendedOptionId ? " (recommended)" : "";
    lines.push(`  ${option.optionId}: ${option.title}${marker}`);
  }
  lines.push(
    "",
    `Concept gate is ${snapshot.state}. STOP — choose one:`,
    "  mmcs approve concept                approve the recommended option",
    "  mmcs approve concept --option <id>  approve a specific option",
    "  mmcs approve concept --reject       send back for revision",
    "",
    "No screenplay work happens before concept approval (spec §3 gate 1).",
  );
  return { exitCode: 0, output: lines };
}

/**
 * Execute `mmcs approve concept`: apply the operator decision to the gate.
 * The decision itself is the store's — this contract validates the REQUEST
 * and reports the outcome. Rejection reasons are value-free (no story text).
 */
export async function runApproveConcept(
  options: ApproveConceptOptions,
  ports: DevelopConceptPorts,
): Promise<ConceptCommandResult> {
  if (options.help) {
    return { exitCode: 0, output: [USAGE_APPROVE_CONCEPT] };
  }
  if (options.reject && options.reopen) {
    return {
      exitCode: 2,
      output: ["--reject and --reopen are mutually exclusive.", "", USAGE_APPROVE_CONCEPT],
    };
  }

  const before = await ports.gates.snapshot("concept");

  if (options.reopen) {
    if (before.state === "PENDING") {
      return {
        exitCode: 1,
        output: [
          `Concept gate is already ${before.state}; nothing to reopen.`,
          "",
          USAGE_APPROVE_CONCEPT,
        ],
      };
    }
    const after = await ports.gates.reopen("concept", {
      decidedBy: options.by ?? undefined,
      note: options.note ?? undefined,
    });
    return {
      exitCode: 0,
      output: [
        `Concept gate reopened: ${before.state} → ${after.state}.`,
        "Revise the concept, then re-present it with `mmcs develop-concept`.",
      ],
    };
  }

  if (before.state === "APPROVED" && !options.reject) {
    return {
      exitCode: 1,
      output: [
        "Concept gate is already APPROVED; nothing to approve.",
        "Use --reopen to present revised work (spec §3).",
        "",
        USAGE_APPROVE_CONCEPT,
      ],
    };
  }

  if (options.reject) {
    if (before.state === "APPROVED") {
      return {
        exitCode: 2,
        output: [
          "Illegal transition APPROVED → REJECTED (spec §3): reopen first, revise, then reject the revised presentation.",
          "",
          USAGE_APPROVE_CONCEPT,
        ],
      };
    }
    const after = await ports.gates.reject("concept", {
      decidedBy: options.by ?? undefined,
      note: options.note ?? undefined,
    });
    return {
      exitCode: 0,
      output: [
        `Concept gate ${before.state} → ${after.state}: the concept goes back for revision.`,
        "Revise the idea/concept, then run `mmcs develop-concept` again.",
      ],
    };
  }

  if (before.state === "PENDING" || before.state === "REJECTED") {
    if (before.state === "REJECTED") {
      // §3: REJECTED → APPROVED is illegal — must go through reopen.
      return {
        exitCode: 2,
        output: [
          "Illegal transition REJECTED → APPROVED (spec §3): reopen first, present revised work, then approve.",
          "",
          USAGE_APPROVE_CONCEPT,
        ],
      };
    }
    const decision = {
      decidedBy: options.by ?? undefined,
      note: options.note ?? undefined,
    };
    const after = await ports.gates.approve("concept", decision);
    const optionLine =
      options.option === null
        ? "the recommended option"
        : `option ${options.option}`;
    return {
      exitCode: 0,
      output: [
        `Concept gate APPROVED (${optionLine}) by ${options.by ?? "operator"}.`,
        `Gate state: ${before.state} → ${after.state}.`,
        "",
        "Next: `mmcs write-script` (gate 2). Screenplay work is now unblocked.",
      ],
    };
  }

  // Unreachable in practice (states are PENDING/APPROVED/REJECTED); kept for
  // exhaustiveness with a value-free message.
  return {
    exitCode: 1,
    output: [
      `Concept gate is in state ${before.state}; no decision applied.`,
      "",
      USAGE_APPROVE_CONCEPT,
    ],
  };
}
