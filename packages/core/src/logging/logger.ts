/// <reference types="node" />
import { applyRedaction } from "./redact.js";
import {
  isLevelEnabled,
  levelSeverity,
  type LogContext,
  type LogLevel,
  type LogRecord,
  type LogSink,
  type LoggerOptions,
  type RedactionHook,
} from "./types.js";

/** Minimum level from env; unparseable values fall back to the option default. */
function envLevel(): LogLevel | undefined {
  const raw = process.env["LOG_LEVEL"];
  if (!raw) return undefined;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "debug" || normalized === "info" || normalized === "warn" || normalized === "error") {
    return normalized;
  }
  return undefined;
}

/** Default sink: JSON line to stdout; warn/error to stderr. */
export const defaultSink: LogSink = (record, line) => {
  const target = levelSeverity(record.level) >= levelSeverity("warn") ? process.stderr : process.stdout;
  target.write(line + "\n");
};

function serialize(record: LogRecord): string {
  return JSON.stringify(record);
}

/**
 * A leveled structured logger. Every emit produces one JSON line shaped as
 * `{ time, level, message, context }` where context carries the bound
 * task-id/agent fields plus per-call fields, all passed through redaction.
 * Never throws: a sink failure is swallowed (logging must not take the
 * pipeline down).
 */
export interface Logger {
  readonly level: LogLevel;
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
  /** True when this level would pass the threshold (skips expensive work). */
  isEnabled(level: LogLevel): boolean;
  /** Derive a child logger with additional bound context; hooks are inherited. */
  child(context: LogContext): Logger;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const threshold = envLevel() ?? options.level ?? "info";
  const boundContext: LogContext = options.context ?? {};
  const hooks: RedactionHook[] = options.redact ?? [];
  const sink: LogSink = options.sink ?? defaultSink;

  const emit = (level: LogLevel, message: string, context?: LogContext): void => {
    if (!isLevelEnabled(level, threshold)) return;
    const merged: LogContext = { ...boundContext, ...context };
    const safe = applyRedaction(merged, hooks);
    const record: LogRecord = {
      time: new Date().toISOString(),
      level,
      message,
      context: safe,
    };
    try {
      sink(record, serialize(record));
    } catch {
      // Logging must never crash the caller.
    }
  };

  return {
    level: threshold,
    debug: (message, context) => emit("debug", message, context),
    info: (message, context) => emit("info", message, context),
    warn: (message, context) => emit("warn", message, context),
    error: (message, context) => emit("error", message, context),
    isEnabled: (level) => isLevelEnabled(level, threshold),
    child: (context) =>
      createLogger({ level: threshold, context: { ...boundContext, ...context }, sink, redact: hooks }),
  };
}