/// <reference types="node" />
import { describe, expect, it } from "vitest";

import {
  createLogger,
  defaultSink,
  isLevelEnabled,
  levelSeverity,
  type LogRecord,
} from "./index.js";

function capture(): { records: LogRecord[]; sink: (record: LogRecord, line: string) => void } {
  const records: LogRecord[] = [];
  return {
    records,
    sink: (record) => {
      records.push(record);
    },
  };
}

describe("levelSeverity", () => {
  it("orders debug < info < warn < error", () => {
    expect(levelSeverity("debug")).toBeLessThan(levelSeverity("info"));
    expect(levelSeverity("info")).toBeLessThan(levelSeverity("warn"));
    expect(levelSeverity("warn")).toBeLessThan(levelSeverity("error"));
  });
});

describe("isLevelEnabled", () => {
  it("filters below the threshold", () => {
    expect(isLevelEnabled("debug", "info")).toBe(false);
    expect(isLevelEnabled("info", "info")).toBe(true);
    expect(isLevelEnabled("warn", "info")).toBe(true);
  });
});

describe("createLogger", () => {
  it("emits a JSON line with time, level, message, and context fields", () => {
    const { records, sink } = capture();
    const log = createLogger({ level: "info", context: { taskId: "TASK-1", agent: "builder" }, sink });
    log.info("hello", { extra: 1 });

    expect(records).toHaveLength(1);
    const record = records[0]!;
    expect(record.level).toBe("info");
    expect(record.message).toBe("hello");
    expect(record.context.taskId).toBe("TASK-1");
    expect(record.context.agent).toBe("builder");
    expect(record.context.extra).toBe(1);
    expect(record.time).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // Serialized form is valid single-line JSON.
    const line = JSON.stringify(record);
    expect(() => JSON.parse(line)).not.toThrow();
    expect(line).not.toContain("\n");
  });

  it("suppresses records below the threshold", () => {
    const { records, sink } = capture();
    const log = createLogger({ level: "warn", sink });
    log.debug("no");
    log.info("no");
    log.warn("yes");
    log.error("yes");
    expect(records.map((r) => r.level)).toEqual(["warn", "error"]);
  });

  it("per-call context overrides bound context", () => {
    const { records, sink } = capture();
    const log = createLogger({ context: { agent: "builder" }, sink });
    log.info("m", { agent: "qc" });
    expect(records[0]!.context.agent).toBe("qc");
  });

  it("child loggers inherit bound context and hooks", () => {
    const { records, sink } = capture();
    const parent = createLogger({ context: { taskId: "T" }, sink });
    const child = parent.child({ agent: "qc" });
    child.info("from child");
    expect(records[0]!.context.taskId).toBe("T");
    expect(records[0]!.context.agent).toBe("qc");
  });

  it("isEnabled skips work below the threshold", () => {
    const log = createLogger({ level: "error", sink: () => {} });
    expect(log.isEnabled("debug")).toBe(false);
    expect(log.isEnabled("error")).toBe(true);
  });

  it("swallows sink failures", () => {
    const log = createLogger({ sink: () => { throw new Error("sink exploded"); } });
    expect(() => log.error("still fine")).not.toThrow();
  });
});

describe("defaultSink", () => {
  it("writes to stdout for info", () => {
    const writes: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => { writes.push(chunk); return true; }) as typeof process.stdout.write;
    try {
      defaultSink({ time: "t", level: "info", message: "m", context: {} }, '{"time":"t"}');
    } finally {
      process.stdout.write = orig;
    }
    expect(writes[0]).toBe('{"time":"t"}\n');
  });

  it("writes to stderr for error", () => {
    const writes: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => { writes.push(chunk); return true; }) as typeof process.stderr.write;
    try {
      defaultSink({ time: "t", level: "error", message: "m", context: {} }, '{"time":"t"}');
    } finally {
      process.stderr.write = orig;
    }
    expect(writes[0]).toBe('{"time":"t"}\n');
  });
});