/// <reference types="node" />
/**
 * CLI wrapper for the batch merge engine (task REC-009).
 *
 *   npx tsx scripts/orchestration/batch-merge.cli.ts [--dry-run] [--no-push] [--root <dir>]
 *
 * `--dry-run` is the safe inspection mode: full admission + ordering +
 * conflict plan, zero mutations (runbook §7.2 acceptance). The 10-minute loop
 * (`/loop 10m /mmcs-batch-merge`) invokes the SKILL.md flow, which calls this
 * CLI or the engine directly.
 */
import { BatchMergeEngine, DEFAULT_REPO_ROOT, RealGitAdapter } from "./batch-merge.js";

function parseArgs(argv: string[]): {
  dryRun: boolean;
  push: boolean;
  repoRoot: string;
} {
  let dryRun = false;
  let push = true;
  let repoRoot = DEFAULT_REPO_ROOT;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--dry-run") dryRun = true;
    else if (a === "--no-push") push = false;
    else if (a === "--push") push = true;
    else if (a === "--root") {
      i += 1;
      const v = argv[i];
      if (v) repoRoot = v;
    } else if (a === "--help" || a === "-h") {
      console.log(
        "usage: batch-merge.cli.ts [--dry-run] [--no-push|--push] [--root <repoRoot>]",
      );
      process.exit(0);
    }
  }
  return { dryRun, push, repoRoot };
}

async function main(): Promise<void> {
  const { dryRun, push, repoRoot } = parseArgs(process.argv.slice(2));
  const engine = new BatchMergeEngine({
    repoRoot,
    dryRun,
    push,
    git: new RealGitAdapter(repoRoot),
  });
  const report = await engine.run();
  console.log(
    JSON.stringify(
      {
        dryRun: report.dryRun,
        lockAcquired: report.lockAcquired,
        candidates: report.candidates,
        rejected: report.rejected,
        ordered: report.ordered,
        conflicts: report.conflicts,
        merged: report.merged.map((m) => ({
          taskId: m.taskId,
          status: m.status,
          mergeSha: m.mergeSha,
          detail: m.detail,
        })),
        batchMergedSha: report.batchMergedSha,
        regressionOk: report.regression?.ok ?? null,
        affectedAreas: report.regression?.affectedAreas ?? [],
        reverted: report.reverted,
        culprits: report.culprits,
        pushed: report.pushed,
        pushDetail: report.pushDetail,
        queueAfter: report.queueAfter,
        evidencePath: report.evidencePath,
        notes: report.notes,
        lockError: report.lockError,
      },
      null,
      2,
    ),
  );
  // Exit 0 even on rejected items (that is a normal, inspected outcome);
  // exit 1 only when the lock could not be acquired (operator attention).
  process.exitCode = report.lockAcquired ? 0 : 1;
}

main().catch((err) => {
  console.error(String((err as Error).message ?? err));
  process.exitCode = 1;
});
