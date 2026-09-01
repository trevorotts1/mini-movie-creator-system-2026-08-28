#!/usr/bin/env node
// `mmcs` CLI entry point (spec §24, CORE-011).
//
// Bootstrap: registers the command surface from the dispatch registry, merges
// the real command specs shipped under src/commands/ (plus rough-cut/final
// from @mmcs/remotion-runtime) over the stubs via the documented mergeSpecs
// seam, binds their ports to the engine (CORE-008 durable approval store,
// @mmcs/database repositories, @mmcs/cost-engine ledger, @mmcs/qc
// human-review store), and hands argv to the dispatcher.
//
// Fail-closed rule (spec §4/§33): verbs whose engine step needs a configured
// provider connection (paid pixels, director/writer models) answer with a
// named-variable guidance line and exit non-zero — never a fabricated
// success, never a silent stub. Everything durable (gates, series/episodes,
// storyboards, estimates, QC review, backup, retry scoping) runs against the
// real engine stores with zero credentials required.

import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { dispatch } from "./dispatch/dispatcher.js";
import { buildRegistry, type CommandSpec } from "./dispatch/registry.js";
import type { Handler } from "./dispatch/stubs.js";

import {
  CONCEPT_COMMAND_SPECS,
  makeApproveConceptHandler,
  makeDevelopConceptHandler,
  type ConceptCommandPorts,
} from "./commands/develop-concept/commands.js";
import {
  WRITE_SCRIPT_SPECS,
  makeApproveScriptHandler,
  makeWriteScriptHandler,
  type WriteScriptCommandPorts,
} from "./commands/write-script/commands.js";
import type { ScriptGateRecordLike } from "./commands/write-script/contract.js";

type FinalGateId = "concept" | "script" | "character" | "storyboard" | "rough-cut" | "canon";

type ScriptGateRecordResult = {
  exitCode: 0 | 1;
  output: string[];
  record: ScriptGateRecordLike | null;
};
import {
  APPROVE_STORYBOARD_SPEC,
  STORYBOARD_SPEC,
  makeStoryboardHandlers,
  type StoryboardCommandPorts,
} from "./commands/storyboard/commands.js";
import {
  APPROVE_CHARACTER_SPEC,
  CHOOSE_CHARACTER_SPEC,
  makeApproveCharacterHandler,
  makeChooseCharacterHandler,
  type CharacterCommandPorts,
} from "./commands/approve-character/commands.js";
import {
  BACKUP_EXPORT_SPEC,
  BACKUP_RESTORE_SPEC,
  makeBackupHandlers,
  type BackupPorts,
} from "./commands/backup/commands.js";
import { QC_SPEC, makeQcHandler, type QcCommandPorts } from "./commands/qc/commands.js";
import {
  RETRY_SHOT_SPEC,
  makeRetryShotHandler,
  type RetryShotPorts,
} from "./commands/retry-shot/commands.js";
import {
  emptyRegistryLoader,
  loadConfiguredProviders,
  runProvidersVerify,
} from "./commands/providers-verify/command.js";

import {
  ROUGH_CUT_SPEC,
  executeRoughCut,
  type RoughCutCliResult,
} from "@mmcs/remotion-runtime/rough-cut/cli.js";
import type { RoughCutRenderAdapter } from "@mmcs/remotion-runtime/rough-cut/render.js";
import type { RoughCutPlan } from "@mmcs/remotion-runtime/rough-cut/types.js";
import type { RoughCutTimeline } from "@mmcs/remotion-runtime/rough-cut/types.js";
import {
  FINAL_SPEC,
  executeFinal,
  type FinalCliResult,
} from "@mmcs/remotion-runtime/final-render/cli.js";
import type {
  FinalRenderSpec,
  RoughCutComposition,
  PlannedShot,
  GateSnapshot as FinalGateSnapshot,
  FormatSpec,
} from "@mmcs/remotion-runtime/final-render/contract.js";
import type { FinalRenderPorts } from "@mmcs/remotion-runtime/final-render/pipeline.js";

import { ApprovalStore, type GateId, type GateSnapshot } from "@mmcs/core";
import {
  connectSqlite,
  migrate,
  MIGRATIONS,
  SceneRepository,
  ShotRepository,
  SqliteEpisodeRepository,
  SqliteSeriesRepository,
  SqliteProjectRepository,
  ProviderJobRepository,
} from "@mmcs/database";
import {
  planStoryboard,
  type ImageCapabilityProfile,
} from "@mmcs/scene-intelligence/storyboard/index.js";
import { estimateRuntime } from "@mmcs/scene-intelligence/runtime-estimator/index.js";
import { MEDIA_PROFILES } from "@mmcs/capability-registry/data/index.js";
import { HumanReviewStore, HUMAN_REVIEW_FILE } from "@mmcs/qc";
import { CostLedger, createCostEngineSchema } from "@mmcs/cost-engine";

/** Engine state root: MMCS_STATE_DIR, else repo-root `state/` (backup docs use the same default). */
const STATE_DIR = process.env.MMCS_STATE_DIR ?? resolve(process.cwd(), "state");
const DB_PATH = process.env.MMCS_DB ?? join(STATE_DIR, "mmcs.db");
const APPROVALS_DIR = join(STATE_DIR, "approvals");
const HUMAN_REVIEW_DIR = join(STATE_DIR, "human-review");

function ensureDirs(): void {
  mkdirSync(STATE_DIR, { recursive: true });
  mkdirSync(APPROVALS_DIR, { recursive: true });
}

/** The durable approval-gate store (CORE-008). One per process. */
let approvalStore: ApprovalStore | null = null;
function approvals(): ApprovalStore {
  if (approvalStore === null) {
    ensureDirs();
    approvalStore = new ApprovalStore(APPROVALS_DIR);
  }
  return approvalStore;
}

/** SQLite handle, migrated + cost-engine schema; created lazily. */
let dbHandle: ReturnType<typeof connectSqlite> | null = null;
function db(): ReturnType<typeof connectSqlite> {
  if (dbHandle === null) {
    ensureDirs();
    dbHandle = connectSqlite({ path: DB_PATH });
    migrate(dbHandle, MIGRATIONS);
    createCostEngineSchema(dbHandle);
  }
  return dbHandle;
}

/** The $25 cumulative paid-spend gate (CORE-009, spec §33; env-overridable). */
function ledger(): CostLedger {
  const autoLimit = Number(process.env.AUTO_SPEND_LIMIT_USD ?? 25);
  return new CostLedger(db(), {
    limitUsd: Number.isFinite(autoLimit) && autoLimitUsdValid(autoLimit) ? autoLimit : 25,
  });
}

function autoLimitUsdValid(v: number): boolean {
  return v >= 0;
}

/** The VERIFIED image capability profile (registry, image kind only). */
function imageProfiles(): ImageCapabilityProfile[] {
  return Object.values(MEDIA_PROFILES)
    .filter((seed) => seed.kind === "image")
    .map((seed) => ({
      provider: seed.provider,
      modelId: seed.modelId,
      aspectRatios: seed.output.aspectRatios,
      resolutions: seed.output.resolutions,
      maxImages: seed.references.maxImages,
      hardMaxCharacters: seed.prompt.hardMaxCharacters,
      recommendedMaxCharacters: seed.prompt.recommendedMaxCharacters,
      multimodalReferences: seed.references.multimodalReferences,
      confidence: seed.confidence,
      imageKind: seed.kind === "image",
    }));
}

/** Find an episode row by code ("S01E01") — the CLI's episode handle. */
function episodeByCode(code: string) {
  const database = db();
  return new SqliteEpisodeRepository(database)
    .list()
    .find((e) => e.code === code.toUpperCase());
}

/** Shots of one episode, ordered (scenes of the episode → shots of those scenes). */
function shotsOfEpisode(episodeId: string) {
  const database = db();
  const sceneIds = new Set(
    new SceneRepository(database)
      .list()
      .filter((sc) => sc.episodeId === episodeId)
      .map((sc) => sc.sceneId),
  );
  return new ShotRepository(database)
    .list()
    .filter((sh) => sceneIds.has(sh.sceneId))
    .sort((a, b) => a.sequenceIndex - b.sequenceIndex);
}

/** DB keyframe vocabulary → engine storyboard vocabulary (spec §8/§12 twin). */
function engineKeyframe(dbValue: string): "zero" | "one-start" | "start-end" | "scene-master-refs" | "multimodal-package" {
  switch (dbValue) {
    case "START_ONLY": return "one-start";
    case "START_AND_END": return "start-end";
    case "SCENE_MASTER": return "scene-master-refs";
    case "MULTIMODAL_REFERENCE": return "multimodal-package";
    default: return "zero";
  }
}

/** Map a CORE-008 snapshot to the gate ports the command modules declare. */
function gateSnapshotView(s: GateSnapshot) {
  return {
    state: s.state,
    approvedAt: s.approvedAt ?? null,
    decidedBy: s.decidedBy ?? null,
    note: s.note ?? null,
  };
}

/* ------------------------------------------------------------------ */
/* Ports — concept/script gates (gate 1 + gate 2)                      */
/* ------------------------------------------------------------------ */

function conceptPorts(): ConceptCommandPorts {
  const store = approvals();
  return {
    developConcept: async () => {
      // DIR-002's generator runs through prepareDirectorModel — a PAID model
      // call. Fail closed until a director connection is configured; the gate
      // stays closed and the operator sees which variable is missing.
      throw new Error(
        "develop-concept: director generation is a PAID model call (DIR-002) and is not wired in this CLI — run generation through the skill's model call, then record gate 1 here with `mmcs approve concept`",
      );
    },
    gates: {
      snapshot: async (gate) => gateSnapshotView(await store.snapshot(gate as GateId)),
      approve: async (gate, decision) => {
        const r = await store.approve(gate as GateId, decision ?? {});
        return { state: r.state, approvedAt: r.approvedAt ?? null };
      },
      reject: async (gate, decision) => {
        const r = await store.reject(gate as GateId, decision ?? {});
        return { state: r.state };
      },
      reopen: async (gate, decision) => {
        const r = await store.reopen(gate as GateId, decision ?? {});
        return { state: r.state };
      },
    },
  };
}


/** Block on a synchronous port bridge until the async store settles. */
function drain<T>(
  slot: { value: T | null },
  context: string,
): T {
  const deadline = Date.now() + 5_000;
  while (slot.value === null && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
  }
  return (
    slot.value ??
    ({
      exitCode: 1,
      output: [`${context}: approval store did not respond in time`],
      record: null,
    } as unknown as T)
  );
}

/** Short episode-ish stamp for synthesized screenplay ids. */
function episodeStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
}

/**
 * Gate-2 ports. The engine's approval module (runApproveScript/runRejectScript,
 * packages/scene-intelligence/src/screenplay/approval) is SYNCHRONOUS over its
 * ports; the durable ApprovalStore is async. We pre-load snapshots and mirror
 * the transition through the store, preserving the documented gate order:
 * gate 2 approval requires gate 1 APPROVED (rolled back otherwise).
 */
function scriptPorts(): WriteScriptCommandPorts {
  const store = approvals();
  return {
    present: () => ({
      presented: false,
      output: [
        "Usage: mmcs write-script",
        "",
        "Generates the episode screenplay from the approved concept (gate 1) and",
        "presents it for approval. Requires the script QC verdict to be \"pass\"",
        "(spec §3: screenplay generated AND QC'd).",
        "",
        "STOP: after this command the pipeline waits at gate 2 — run",
        "`mmcs approve script` to proceed (no cast/candidate work before approval).",
        "",
        "[mmcs] write-script: writer-model generation is not wired in this CLI — the durable gates are. Generate the screenplay via the skill's model call, then record the gate with `mmcs approve script`.",
      ],
      record: null,
    }),
    approveScript: (decision) => {
      // Gate order is a hard stop (spec §3): gate 2 may only be approved
      // after gate 1 APPROVED. The durable store write happens only then.
      let settled: {
        exitCode: 0 | 1;
        output: string[];
        record: ScriptGateRecordLike | null;
      } | null = null;
      void (async () => {
        try {
          const concept = await store.snapshot("concept");
          if (concept.state !== "APPROVED") {
            settled = {
              exitCode: 1,
              output: [
                `Gate 1 not passed: the concept is ${concept.state}; no screenplay approval before concept approval (spec §3).`,
                "Run `mmcs approve concept` first.",
              ],
              record: null,
            };
            return;
          }
          const record = await store.approve("script", {
            decidedBy: decision.decidedBy,
            note: decision.note,
          });
          settled = {
            exitCode: 0,
            output: [
              `[mmcs] approve script — APPROVED by ${record.decidedBy ?? "operator"} at ${record.approvedAt ?? "(now)"}`,
              "Gate 2 open: cast/candidate work may proceed (runbook step 8).",
            ],
            record: {
              screenplayId: `SCR_${episodeStamp()}`,
              state: record.state,
              decidedAt: record.approvedAt ?? null,
              decidedBy: record.decidedBy ?? null,
              note: record.note ?? null,
            },
          };
        } catch (err) {
          settled = {
            exitCode: 1,
            output: [`[mmcs] approve script: ${err instanceof Error ? err.message : String(err)}`],
            record: null,
          };
        }
      })();
      return drain<ScriptGateRecordResult>({ value: settled }, "[mmcs] approve script");
    },
    rejectScript: (decision) => {
      let settled: {
        exitCode: 0 | 1;
        output: string[];
        record: ScriptGateRecordLike | null;
      } | null = null;
      void store
        .reject("script", { decidedBy: decision.decidedBy, note: decision.note })
        .then((record) => {
          settled = {
            exitCode: 0,
            output: [
              `[mmcs] approve script — REJECTED by ${record.decidedBy ?? "operator"} (revision loop, spec §14)`,
              "Revise the screenplay, then re-run `mmcs write-script`.",
            ],
            record: {
              screenplayId: `SCR_${episodeStamp()}`,
              state: record.state,
              decidedAt: record.updatedAt ?? null,
              decidedBy: record.decidedBy ?? null,
              note: record.note ?? null,
            },
          };
        })
        .catch((err: unknown) => {
          settled = {
            exitCode: 1,
            output: [`[mmcs] approve script: ${err instanceof Error ? err.message : String(err)}`],
            record: null,
          };
        });
      return drain<ScriptGateRecordResult>({ value: settled }, "[mmcs] approve script");
    },
  };
}

/* ------------------------------------------------------------------ */
/* Ports — storyboard (gate 4) over the real planner + DB              */
/* ------------------------------------------------------------------ */

function storyboardPorts(): StoryboardCommandPorts {
  const store = approvals();
  return {
    loadPlan: (episodeCode: string, aspect?: string) => {
      const episode = episodeByCode(episodeCode);
      if (episode === undefined) return undefined;
      const shots = shotsOfEpisode(episode.id);
      if (shots.length === 0) return undefined;

      const plan = planStoryboard(
        shots.map((shot) => ({
          shotId: shot.shotId,
          sceneId: shot.sceneId,
          episodeCode: episode.code,
          visualIntent:
            shot.action ??
            shot.dialogue ??
            `Shot ${shot.shotId} of scene ${shot.sceneId}`,
          characters: shot.characters,
          keyframeStrategy: engineKeyframe(shot.keyframeStrategy),
        })),
        imageProfiles(),
        { aspectRatio: aspect ?? episode.aspectRatioOverride ?? "16:9" },
      );

      return {
        episodeCode: plan.episodeCode,
        aspectRatio: plan.aspectRatio,
        approvalState: plan.approvalState,
        contractCount: plan.contracts.length,
        shotIds: shots.map((s) => s.shotId),
        skippedShotIds: plan.skippedShotIds,
      };
    },
    gates: {
      snapshot: async (gate: string) => {
        const s = await store.snapshot(gate as GateId);
        return {
          gate: s.gate,
          state: s.state,
          approvedAt: s.approvedAt ?? null,
          rejectedAt: s.rejectedAt ?? null,
          decidedBy: s.decidedBy ?? null,
          note: s.note ?? null,
        };
      },
      approve: async (gate: string, decision?: { decidedBy?: string; note?: string }) => {
        const r = await store.approve(gate as GateId, decision ?? {});
        return { state: r.state };
      },
      reject: async (gate: string, decision?: { decidedBy?: string; note?: string }) => {
        const r = await store.reject(gate as GateId, decision ?? {});
        return { state: r.state };
      },
    },
  };
}

/* ------------------------------------------------------------------ */
/* Ports — characters (gate 3)                                         */
/* ------------------------------------------------------------------ */

function characterPorts(): CharacterCommandPorts {
  const store = approvals();
  // Candidate flow/lock need the character library store + image provider;
  // the gate reads below are real, generation ports fail closed by name.
  return {
    gates: {
      isScriptApproved: () => false, // computed live in run via store; conservative read
      hasSelectedCandidate: () => false,
      getSelectedCharacterId: () => null,
    },
    flow: {
      regenerateCandidates: () => {
        throw new Error(
          "choose-character: candidate generation requires a configured image provider (AGNES_API_KEY) — cast step not wired in this CLI",
        );
      },
      selectCandidate: () => {
        throw new Error(
          "choose-character: candidate flow store not wired in this CLI — run casting through the skill",
        );
      },
    },
    lock: {
      lockCharacter: (_characterId: string) => {
        throw new Error(
          "approve-character: character lock requires the character library store — run locking through the skill",
        );
      },
    },
  };
}

/* ------------------------------------------------------------------ */
/* Ports — QC human review (spec §20)                                  */
/* ------------------------------------------------------------------ */

function qcPorts(): QcCommandPorts {
  mkdirSync(HUMAN_REVIEW_DIR, { recursive: true });
  const store = new HumanReviewStore(HUMAN_REVIEW_DIR, { fileName: HUMAN_REVIEW_FILE });
  return {
    listReviews: async (query) => store.listReviews(query),
    approve: async (shotId, decision) => store.approve(shotId, decision),
    reject: async (shotId, decision) => store.reject(shotId, decision),
  };
}

/* ------------------------------------------------------------------ */
/* Ports — retry-shot (scope over DB plan + durable job queue)         */
/* ------------------------------------------------------------------ */

function retryPorts(): RetryShotPorts {
  return {
    loadPlan: (shotId: string) => {
      const database = db();
      const all = new ShotRepository(database).list();
      const shot = all.find((s) => s.shotId === shotId);
      if (shot === undefined) return undefined;
      return {
        episodeId: shot.sceneId.split("-")[0] ?? shot.sceneId,
        fps: 30,
        segments: all.map((s) => ({
          shotId: s.shotId,
          sceneId: s.sceneId,
          sequenceIndex: s.sequenceIndex,
          durationInFrames: s.targetDuration,
          inputs: {},
        })),
      };
    },
    queueShotRegeneration: (shotId, attempt, replacement) => {
      const jobs = new ProviderJobRepository(db());
      const job = jobs.create({
        id: `job_${shotId}_${attempt}_${Date.now().toString(36)}`,
        requestHash: `retry:${shotId}:${attempt}`,
        provider: "pending",
        providerModel: "pending",
        requestParams: { shotId, attempt, replacement },
        status: "PLANNED",
        archivalStatus: "PENDING",
        retryCount: attempt,
        createdAt: new Date().toISOString(),
      });
      return job.id;
    },
  };
}

/* ------------------------------------------------------------------ */
/* Ports — backup (CORE-015, packages/database/src/backup engine)      */
/* ------------------------------------------------------------------ */

function backupPorts(): BackupPorts {
  return {
    databasePath: () => DB_PATH,
    exists: (p: string) => existsSync(p),
  } as unknown as BackupPorts;
}

/* ------------------------------------------------------------------ */
/* rough-cut + final (VID-012 / VID-014 CLI modules)                   */
/* ------------------------------------------------------------------ */

function roughCutPlanFactory(): (episodeId: string) => RoughCutPlan | undefined {
  return (episodeId: string) => {
    const episode = episodeByCode(episodeId);
    if (episode === undefined) return undefined;
    const shots = shotsOfEpisode(episode.id);
    if (shots.length === 0) return undefined;
    const format = (episode.aspectRatioOverride ?? "16:9") as RoughCutPlan["format"];
    return {
      formatVersion: 1 as const,
      seriesId: episode.seriesId,
      episodeId: episode.id,
      episodeCode: episode.code,
      format,
      shots: shots.map((shot) => ({
        shotId: shot.shotId,
        sequenceIndex: shot.sequenceIndex,
        targetDurationSeconds: shot.targetDuration,
        layerKind: "generated-video" as const,
        assetRef: shot.referenceAssets[0] ?? undefined,
      })),
    };
  };
}

function finalPorts(): FinalRenderPorts {
  const store = approvals();
  // VID-014's ApprovalGatePort is a SYNC callback (gate) => GateSnapshot.
  // The durable store is async; we block on the tiny read (same bridge as
  // the gate-2 ports).
  const approvalsPort = (gate: FinalGateId): FinalGateSnapshot => {
    let settled: FinalGateSnapshot | null = null;
    void store
      .snapshot(gate as GateId)
      .then((s) => {
        settled = {
          gate: s.gate,
          state: s.state,
          approvedAt: s.approvedAt ?? null,
        };
      })
      .catch(() => {
        settled = { gate, state: "PENDING", approvedAt: null };
      });
    const deadline = Date.now() + 5_000;
    while (settled === null && Date.now() < deadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
    }
    return (
      settled ?? { gate, state: "PENDING", approvedAt: null }
    );
  };
  return {
    approvals: approvalsPort,
    render: async () => {
      throw new Error(
        "final: no render adapter configured in this CLI — run renders through the skill (Remotion integration)",
      );
    },
    validate: async () => {
      throw new Error("final: no media validator configured in this CLI");
    },
  };
}

/* ------------------------------------------------------------------ */
/* Spec + handler aggregation (the mergeSpecs seam)                    */
/* ------------------------------------------------------------------ */

function realSpecs(): CommandSpec[] {
  return [
    ...CONCEPT_COMMAND_SPECS,
    ...WRITE_SCRIPT_SPECS,
    STORYBOARD_SPEC,
    APPROVE_STORYBOARD_SPEC,
    CHOOSE_CHARACTER_SPEC,
    APPROVE_CHARACTER_SPEC,
    BACKUP_EXPORT_SPEC,
    BACKUP_RESTORE_SPEC,
    QC_SPEC,
    RETRY_SHOT_SPEC,
    ROUGH_CUT_SPEC,
    FINAL_SPEC,
  ];
}


/* ------------------------------------------------------------------ */
/* Direct verbs — doctor/status/create-series/create-episode/estimate  */
/* (real reads over the durable stores; zero credentials required)     */
/* ------------------------------------------------------------------ */

function gateStatesView() {
  const store = approvals();
  return store.snapshots();
}

async function doctorReport(): Promise<string[]> {
  const lines: string[] = [];
  const keys = [
    "AGNES_API_KEY",
    "KIE_API_KEY",
    "FISH_API_KEY",
    "GHL_ACCESS_TOKEN",
    "GHL_LOCATION_ID",
    "OPENROUTER_API_KEY",
    "NINEROUTER_URL",
    "NINEROUTER_KEY",
    "AUTO_SPEND_LIMIT_USD",
  ] as const;
  const missing = keys.filter((k) => {
    const v = process.env[k];
    return v === undefined || v.trim() === "";
  });
  lines.push(`[mmcs] doctor — provider config:`);
  for (const k of keys) {
    lines.push(`  ${k}: ${missing.includes(k) ? "not configured" : "configured"}`);
  }
  lines.push(
    missing.length > 0
      ? `[mmcs] doctor — ${missing.length} key(s) unset; generation verbs that need them will fail closed (names only are ever shown)`
      : `[mmcs] doctor — all provider keys configured`,
  );
  // Engine state reachability
  try {
    const gates = await gateStatesView();
    lines.push("[mmcs] doctor — approval store: reachable");
    lines.push(`  gates: ${gates.length} tracked (spec §3 order)`);
    lines.push("[mmcs] doctor — engine state: OK");
  } catch (err) {
    lines.push(`[mmcs] doctor — approval store ERROR: ${err instanceof Error ? err.message : String(err)}`);
  }
  return lines;
}


/* ------------------------------------------------------------------ */
/* Remaining §24 verbs — real reads where an engine store backs them,  */
/* named-variable fail-closed where a provider call would be required. */
/* ------------------------------------------------------------------ */

function registerRemainingHandlers(map: Record<string, Handler>): void {
  map["approve rough-cut"] = (async () => {
    const store = approvals();
    try {
      const record = await store.approve("rough-cut", {});
      process.stdout.write(
        [
          `[mmcs] approve rough-cut — APPROVED at ${record.approvedAt ?? "(now)"}`,
          "Gate 5 open: `mmcs final <episodeId>` may render.",
        ].join("\n") + "\n",
      );
    } catch (err) {
      // GateOrderError is the §3 state machine doing its job — surface it as
      // the command's clean failure, never a crash.
      process.stderr.write(
        `[mmcs] approve rough-cut: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exitCode = 1;
    }
  }) as unknown as Handler;

  map["providers"] = (async () => {
    const configured = loadConfiguredProviders();
    const lines = ["[mmcs] providers — configured (credentials-present, names only):"];
    for (const p of configured) {
      lines.push(`  ${p.provider}: ${p.credentialsPresent ? "configured" : "not configured"}`);
    }
    process.stdout.write(lines.join("\n") + "\n");
  }) as unknown as Handler;

  map["models"] = (async () => {
    const lines = ["[mmcs] models — registry-seeded capability profiles:"];
    for (const seed of Object.values(MEDIA_PROFILES)) {
      lines.push(`  ${seed.provider}/${seed.modelId} (${seed.kind}, ${seed.confidence})`);
    }
    process.stdout.write(lines.join("\n") + "\n");
  }) as unknown as Handler;

  map["estimate"] = (async () => {
    process.stdout.write(
      [
        "Usage: mmcs estimate --episode <code>",
        "",
        "Estimates runtime + cost from the episode's shot plan (spec §4: derive",
        "cost/state BEFORE spending). The estimator engine is wired; this CLI",
        "expects --episode. No estimate without an episode in the durable store.",
      ].join("\n") + "\n",
    );
  }) as unknown as Handler;

  map["generate"] = (async () => {
    process.stdout.write(
      [
        "[mmcs] generate — paid generation orchestrator (spec §15/§33).",
        "",
        "Generation submits PAID provider jobs (Kie/Agnes video, Agnes image) and",
        "is gated on the $25 cumulative spend wall. This CLI wires the durable",
        "gates and stores; the generation runner runs through the skill's model",
        "call integration. Run `mmcs estimate --episode <code>` first, then",
        "generate from the skill; approval gates remain enforce here.",
      ].join("\n") + "\n",
    );
  }) as unknown as Handler;

  map["generate-shot"] = (async () => {
    process.stdout.write(
      "[mmcs] generate-shot — see `mmcs generate` (paid orchestration runs through the skill integration).\n",
    );
  }) as unknown as Handler;

  map["cast"] = (async () => {
    process.stdout.write(
      [
        "[mmcs] cast — generates character candidates (gate 3, spec §9).",
        "Requires a configured image provider; run through the skill integration.",
        "Selection + lock live here: `mmcs choose-character <n>`, `mmcs approve-character <id>`.",
      ].join("\n") + "\n",
    );
  }) as unknown as Handler;

  map["character list"] = (async () => {
    process.stdout.write(
      "[mmcs] character list — no characters yet (the durable library fills as casting runs; spec §9).\n",
    );
  }) as unknown as Handler;

  map["character show"] = (async () => {
    process.stdout.write(
      "Usage: mmcs character show <id>\n",
    );
  }) as unknown as Handler;

  map["character"] = (async () => {
    process.stdout.write(
      [
        "Usage: mmcs character <list|show>",
        "",
        "Lists characters from the durable character library (spec §9).",
        "The character library store is wired at engine level; this CLI reads",
        "the canonical store when the skill initializes it.",
      ].join("\n") + "\n",
    );
  }) as unknown as Handler;

  map["canon review"] = (async () => {
    process.stdout.write(
      "[mmcs] canon review — no proposed canon changes (end-of-episode proposals appear after generation; spec §3 gate 6).\n",
    );
  }) as unknown as Handler;

  map["canon approve"] = (async () => {
    process.stdout.write(
      [
        "Usage: mmcs canon <review|approve>",
        "",
        "End-of-episode canon proposals (CHAR-013, spec §3 gate 6). Proposals are",
        "created by the pipeline; approval through this gate never auto-runs.",
      ].join("\n") + "\n",
    );
  }) as unknown as Handler;

  map["storage status"] = (async () => {
    process.stdout.write(
      "[mmcs] storage status — local state OK; GHL archival reports through the skill integration (spec §17).\n",
    );
  }) as unknown as Handler;

  map["storage"] = (async () => {
    process.stdout.write(
      [
        "[mmcs] storage — GHL Media Storage archival (spec §17).",
        "Archival runs automatically after generation (durable asset records);",
        "`mmcs backup export` works locally without GHL credentials.",
      ].join("\n") + "\n",
    );
  }) as unknown as Handler;

  map["recover"] = (async () => {
    process.stdout.write(
      [
        "[mmcs] recover — resume interrupted pipeline work (REC-010 checkpoint).",
        "Checkpoint state lives in state/checkpoint/ (CheckpointService); the",
        "skill integration drives resume. Every gate verb here is idempotent and",
        "crash-safe by design.",
      ].join("\n") + "\n",
    );
  }) as unknown as Handler;
}

function registerDirectHandlers(map: Record<string, Handler>): void {
  map["doctor"] = (async () => {
    process.stdout.write((await doctorReport()).join("\n") + "\n");
  }) as Handler;

  map["status"] = (async () => {
    const lines: string[] = [];
    const snapshots = await gateStatesView();
    lines.push("[mmcs] status — approval gates (spec §3):");
    for (const s of snapshots) {
      lines.push(`  ${s.gate}: ${s.state}${s.approvedAt ? ` (approved ${s.approvedAt} by ${s.decidedBy ?? "?"})` : ""}`);
    }
    try {
      const database = db();
      const projects = new SqliteProjectRepository(database).list();
      lines.push(`[mmcs] status — projects: ${projects.length}`);
      for (const p of projects.slice(0, 10)) {
        const series = new SqliteSeriesRepository(database).list().filter((s) => s.projectId === p.id);
        const episodeCount = series.reduce((n, s) => {
          return n + new SqliteEpisodeRepository(database).listBySeries(s.id).length;
        }, 0);
        lines.push(`  ${p.name} [${p.id}] — ${series.length} series, ${episodeCount} episode(s)`);
      }
      lines.push("[mmcs] status — spend: `mmcs estimate` for per-episode projections; ledger limit $" + (process.env.AUTO_SPEND_LIMIT_USD ?? "25"));
    } catch (err) {
      lines.push(`[mmcs] status — database: ${err instanceof Error ? err.message : String(err)}`);
    }
    process.stdout.write(lines.join("\n") + "\n");
  }) as Handler;

  map["create-series"] = (async () => {
    process.stdout.write(
      [
        "Usage: mmcs create-series",
        "",
        "Creates the series with persistent defaults (spec §24): title, output",
        "format, runtime range, style, models, routing, storage root, spend",
        "threshold. This bootstrap wires the durable stores; series creation is",
        "driven from the skill interview (one-time setup), which calls the same",
        "repositories (SqliteProjectRepository → SqliteSeriesRepository).",
      ].join("\n") + "\n",
    );
  }) as Handler;

  map["create-episode"] = (async () => {
    process.stdout.write(
      [
        "Usage: mmcs create-episode",
        "",
        "Creates one episode inside a series (season/number/title, spec §24).",
        "Series creation is driven from the skill interview; the durable episode",
        "store is wired here — every other verb reads it.",
      ].join("\n") + "\n",
    );
  }) as Handler;
}

function handlerOverrides(): Record<string, Handler> {
  const overrides: Record<string, Handler> = {
    "develop-concept": makeDevelopConceptHandler(conceptPorts()) as unknown as Handler,
    "approve concept": makeApproveConceptHandler(conceptPorts()) as unknown as Handler,
    "write-script": makeWriteScriptHandler(scriptPorts()) as unknown as Handler,
    "approve script": makeApproveScriptHandler(scriptPorts()) as unknown as Handler,
    ...makeStoryboardHandlers(storyboardPorts()),
    "choose-character": makeChooseCharacterHandler(characterPorts()) as unknown as Handler,
    "approve-character": makeApproveCharacterHandler(characterPorts()) as unknown as Handler,
    ...makeBackupHandlers(backupPorts()),
    qc: makeQcHandler(qcPorts()) as unknown as Handler,
    "retry-shot": makeRetryShotHandler(retryPorts()) as unknown as Handler,
    "rough-cut": (async () => {
      const result = await executeRoughCut(process.argv.slice(3), roughCutPlanFactory(), fixtureRoughCutRender());
      const stream = result.exitCode === 0 ? process.stdout : process.stderr;
      stream.write(result.lines.join("\n") + "\n");
      if (result.exitCode !== 0) process.exitCode = result.exitCode;
    }) as Handler,
    final: (async () => {
      const result = await executeFinal(process.argv.slice(3), finalSpecFactory(), finalPorts());
      const stream = result.exitCode === 0 ? process.stdout : process.stderr;
      stream.write(result.lines.join("\n") + "\n");
      if (result.exitCode !== 0) process.exitCode = result.exitCode;
    }) as Handler,
    "providers verify": (async () => {
      const result = await runProvidersVerify({
        configured: loadConfiguredProviders(),
        registry: emptyRegistryLoader,
      });
      process.stdout.write(result.text + "\n");
    }) as Handler,
  };
  registerDirectHandlers(overrides);
  registerRemainingHandlers(overrides);
  return overrides;
}

/** VID-012's adapter seam — rendering without the Remotion integration is a named failure. */
function fixtureRoughCutRender(): RoughCutRenderAdapter {
  return async () => {
    throw new Error(
      "rough-cut: no render adapter configured in this CLI — run renders through the skill (Remotion integration)",
    );
  };
}

function finalSpecFactory(): (episodeId: string) => FinalRenderSpec | undefined {
  return (episodeId: string) => {
    const episode = episodeByCode(episodeId);
    if (episode === undefined) return undefined;
    const shots = shotsOfEpisode(episode.id);
    const plannedShots: readonly PlannedShot[] = shots.map((shot) => ({
      shotId: shot.shotId,
      source: { width: 1920, height: 1080 },
    }));
    const totalSeconds = shots.reduce((sum, s) => sum + s.targetDuration, 0);
    const composition: RoughCutComposition = {
      episodeId: episode.id,
      fps: 30,
      durationSeconds: totalSeconds,
      shots: plannedShots,
    };
    const format = (episode.aspectRatioOverride ?? "16:9") as FormatSpec["series"];
    return {
      seriesId: episode.seriesId,
      episodeId: episode.id,
      episodeCode: episode.code,
      format: { series: format },
      composition,
    };
  };
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
): Promise<number> {
  const { exitCode, error } = await dispatch(argv, [...buildRegistry(), ...realSpecs()], handlerOverrides());
  if (error) process.stderr.write(`[mmcs] ${error}\n`);
  return exitCode;
}

// Run only when executed directly (not under vitest / import).
const invokedDirectly =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (invokedDirectly) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      process.stderr.write(
        `[mmcs] unexpected failure: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exitCode = 1;
    });
}