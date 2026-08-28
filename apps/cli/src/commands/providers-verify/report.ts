/**
 * CAP-009 — Human/JSON report formatting for `mmcs providers verify`
 * (runbook §61). CLI-local copy of the package formatter (CHAR-004 pattern:
 * the CLI never imports `@mmcs/capability-registry`; see verify.ts header).
 * Pure: takes a {@link ProviderVerifyResult}, returns text or a plain JSON
 * object. Never mutates; never reads state.
 *
 * CLI output shape (stable + scriptable):
 *   mmcs providers verify — 2 model(s) checked
 *   agnes/agnes-video-2.5-flash  OK            verified 2026-08-01
 *   kie/wan-3.0                  DISCREPANCY   verified 2026-07-01
 *     WARN [MISMATCH] references.maxImages: documented 5 but runtime observed 10
 *   1 of 2 model(s) with discrepancies; 0 transient probe failure(s)
 */

import type {
  Discrepancy,
  ProviderVerifyReport,
  ProviderVerifyResult,
} from "./verify.js";

/** One summary line per model. */
export function formatReportLine(report: ProviderVerifyReport): string {
  const verified = report.documented.lastVerifiedAt ?? "never";
  return `${report.provider}/${report.modelId}  ${report.status}  verified ${verified}`;
}

/** One indented warning line per discrepancy. */
export function formatDiscrepancyLine(d: Discrepancy): string {
  return `  WARN [${d.severity}] ${d.field}: ${d.message}`;
}

/**
 * Full human-readable report. Ends with the summary counts so scripts can
 * read the last line; warnings always follow their model's line.
 */
export function formatVerifyReport(result: ProviderVerifyResult): string {
  const lines: string[] = [];
  lines.push(
    `mmcs providers verify — ${result.reports.length} model(s) checked at ${result.verifiedAt}`,
  );
  for (const report of result.reports) {
    lines.push(formatReportLine(report));
    for (const d of report.discrepancies) lines.push(formatDiscrepancyLine(d));
  }
  lines.push(
    `${result.discrepancyCount} of ${result.reports.length} model(s) with discrepancies; ` +
      `${result.transientCount} transient probe failure(s)`,
  );
  return lines.join("\n");
}

/** Stable JSON view (plain object — caller serializes). */
export function verifyResultToJson(result: ProviderVerifyResult): unknown {
  return {
    verifiedAt: result.verifiedAt,
    summary: {
      models: result.reports.length,
      withDiscrepancies: result.discrepancyCount,
      transientProbeFailures: result.transientCount,
    },
    reports: result.reports.map((r) => ({
      provider: r.provider,
      modelId: r.modelId,
      status: r.status,
      verificationUsable: r.verificationUsable,
      configured: {
        credentialsPresent: r.configured.credentialsPresent,
        configuredModels: [...r.configured.configuredModels],
      },
      documented: {
        confidence: r.documented.confidence,
        lastVerifiedAt: r.documented.lastVerifiedAt,
        facts: { ...r.documented.facts },
      },
      observed: r.observed.map((o) => ({
        field: o.field,
        value: o.value,
        kind: o.kind,
        ...(o.error !== undefined ? { error: o.error } : {}),
      })),
      discrepancies: r.discrepancies.map((d) => ({
        field: d.field,
        severity: d.severity,
        message: d.message,
        ...(d.documented !== undefined ? { documented: d.documented } : {}),
        ...(d.observed !== undefined ? { observed: d.observed } : {}),
      })),
    })),
  };
}
