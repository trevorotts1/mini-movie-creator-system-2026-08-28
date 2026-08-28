/** Severity levels, ordered lowest → highest. */
export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_SEVERITY: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/** Numeric severity for a level; unknown levels fall back to info. */
export function levelSeverity(level: LogLevel): number {
  return LEVEL_SEVERITY[level] ?? LEVEL_SEVERITY.info;
}

/** True when `candidate` passes the `threshold` filter. */
export function isLevelEnabled(candidate: LogLevel, threshold: LogLevel): boolean {
  return levelSeverity(candidate) >= levelSeverity(threshold);
}

/** Contextual fields bound to a logger or passed per-call. */
export interface LogContext {
  /** Pipeline task this log belongs to (e.g. "TASK-CORE-012"). */
  taskId?: string;
  /** Agent or component emitting the log (e.g. "builder", "qc", "cli"). */
  agent?: string;
  /** Any additional structured fields. */
  [key: string]: unknown;
}

/** A single structured log record as emitted by the sink. */
export interface LogRecord {
  time: string;
  level: LogLevel;
  message: string;
  context: LogContext;
}

/**
 * Where log lines go. Receives the already-serialized JSON string.
 * The default sink writes one JSON object per line to stdout/stderr.
 */
export type LogSink = (record: LogRecord, line: string) => void;

/** Options accepted by {@link createLogger}. */
export interface LoggerOptions {
  /** Minimum level that passes the filter. Default: "info" (LOG_LEVEL env overrides). */
  level?: LogLevel;
  /** Fields attached to every record from this logger. */
  context?: LogContext;
  /** Custom sink; defaults to stdout (stderr for warn/error). */
  sink?: LogSink;
  /**
   * Redaction hooks applied to every record before serialization. Each hook
   * receives the context and returns a scrubbed copy. Built-in token/key
   * redaction always runs last; supply extras for domain-specific scrubbing.
   */
  redact?: RedactionHook[];
}

/** A function that scrubs sensitive values out of a log context. */
export type RedactionHook = (context: LogContext) => LogContext;