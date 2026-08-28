/// <reference types="node" />
import { describe, expect, it } from "vitest";

import { createLogger, type LogRecord } from "./index.js";

/** LOG_LEVEL env override behavior. */
describe("LOG_LEVEL env override", () => {
  it("LOG_LEVEL=debug admits debug records", () => {
    const records: LogRecord[] = [];
    const prev = process.env["LOG_LEVEL"];
    process.env["LOG_LEVEL"] = "debug";
    try {
      const log = createLogger({ level: "error", sink: (r) => records.push(r) });
      log.debug("visible now");
    } finally {
      if (prev === undefined) delete process.env["LOG_LEVEL"];
      else process.env["LOG_LEVEL"] = prev;
    }
    expect(records.map((r) => r.level)).toEqual(["debug"]);
  });

  it("invalid LOG_LEVEL falls back to the option default", () => {
    const records: LogRecord[] = [];
    const prev = process.env["LOG_LEVEL"];
    process.env["LOG_LEVEL"] = "loud";
    try {
      const log = createLogger({ level: "warn", sink: (r) => records.push(r) });
      log.info("filtered out");
      log.warn("kept");
    } finally {
      if (prev === undefined) delete process.env["LOG_LEVEL"];
      else process.env["LOG_LEVEL"] = prev;
    }
    expect(records.map((r) => r.level)).toEqual(["warn"]);
  });
});