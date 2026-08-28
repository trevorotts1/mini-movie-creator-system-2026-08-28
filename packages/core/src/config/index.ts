import { ZodError } from "zod";
import {
  MMCS_ENV_KEYS,
  mmcsOptionalEnvSchema,
  mmcsRequiredEnvSchema,
  type ConfigIssue,
  type MmcsConfig,
  type MmcsPartialConfig,
} from "./schema.js";
import { findEnvFile, loadEnvFile } from "./env-file.js";

export * from "./schema.js";
export { findEnvFile, loadEnvFile, parseEnvFile } from "./env-file.js";

/** Thrown when required environment variables are missing or invalid. */
export class ConfigValidationError extends Error {
  /** One issue per offending variable; never contains variable values. */
  readonly issues: readonly ConfigIssue[];

  constructor(issues: readonly ConfigIssue[]) {
    const names = issues.map((issue) => issue.key).join(", ");
    super(`Invalid MMCS configuration: ${names}. ${issues.map((i) => `${i.key}: ${i.reason}`).join("; ")}`);
    this.name = "ConfigValidationError";
    this.issues = issues;
  }
}

/** Convert a zod failure on the env object into value-free named issues. */
function toConfigIssues(error: ZodError): ConfigIssue[] {
  return error.issues.map((issue) => {
    const key = issue.path.map(String).join(".") || "(root)";
    let reason: string;
    if (issue.code === "invalid_type" && issue.message.includes("received undefined")) {
      reason = "required environment variable is missing";
    } else if (issue.code === "invalid_type") {
      reason = "invalid value type";
    } else {
      reason = issue.message;
    }
    return { key, reason };
  });
}

export interface LoadConfigOptions {
  /**
   * Environment source. Defaults to a repo-root .env merged UNDER process.env
   * (real environment variables win over file values).
   */
  env?: Record<string, string | undefined>;
  /** Skip the automatic .env lookup (tests pass their own env record). */
  noEnvFile?: boolean;
  /** Explicit .env path override; implies noEnvFile=false when provided. */
  envFile?: string;
  /** Working directory used to locate the repo-root .env. */
  startDir?: string;
}

function resolveEnvSource(options: LoadConfigOptions): Record<string, string | undefined> {
  if (options.env) return options.env;
  if (options.envFile) {
    return { ...loadEnvFile(options.envFile), ...process.env };
  }
  if (options.noEnvFile) return { ...process.env };
  const envPath = findEnvFile(options.startDir ?? process.cwd());
  return { ...loadEnvFile(envPath), ...process.env };
}

/**
 * Load and validate the full MMCS configuration. Throws ConfigValidationError
 * naming every missing/invalid variable (never its value).
 */
export function loadConfig(options: LoadConfigOptions = {}): MmcsConfig {
  const source = resolveEnvSource(options);
  const parsed = mmcsRequiredEnvSchema.safeParse(source);
  if (!parsed.success) throw new ConfigValidationError(toConfigIssues(parsed.error));
  return parsed.data;
}

/**
 * Lenient load: missing provider credentials are reported, not thrown.
 * Used by `mmcs doctor` and setup flows.
 */
export function tryLoadConfig(options: LoadConfigOptions = {}): {
  config: MmcsPartialConfig;
  issues: readonly ConfigIssue[];
} {
  const source = resolveEnvSource(options);
  const parsed = mmcsOptionalEnvSchema.safeParse(source);
  if (!parsed.success) {
    // Only reachable if a default itself fails; surface it the same way.
    throw new ConfigValidationError(toConfigIssues(parsed.error));
  }
  const issues: ConfigIssue[] = MMCS_ENV_KEYS.filter((key) => key !== "AUTO_SPEND_LIMIT_USD")
    .filter((key) => parsed.data[key] === undefined)
    .map((key) => ({ key, reason: "not configured (set it in your environment or .env)" }));
  return { config: parsed.data, issues };
}