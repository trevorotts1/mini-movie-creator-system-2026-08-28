import { describe, expect, it } from "vitest";

import {
  applyRedaction,
  createLogger,
  REDACTED,
  redactSensitive,
  type LogRecord,
} from "./index.js";

/** A fake API key with realistic provider shape — never a real credential. */
const FAKE_API_KEY = "sk-test-1234567890abcdef1234567890abcdef";

describe("redactSensitive — key-name based", () => {
  it("redacts apiKey / token / secret / password values", () => {
    const out = redactSensitive({
      apiKey: FAKE_API_KEY,
      token: "tok_abcdef123456",
      accessToken: "longaccesstokenvalue42",
      secret: "hunter2-secret-value",
      password: "p4ssw0rd",
      Authorization: "Bearer abc123",
      GHL_ACCESS_TOKEN: "ghl-token-value-123456",
    });
    expect(out.apiKey).toBe(REDACTED);
    expect(out.token).toBe(REDACTED);
    expect(out.accessToken).toBe(REDACTED);
    expect(out.secret).toBe(REDACTED);
    expect(out.password).toBe(REDACTED);
    expect(out.Authorization).toBe(REDACTED);
    expect(out.GHL_ACCESS_TOKEN).toBe(REDACTED);
  });

  it("is case-insensitive and matches key fragments", () => {
    const out = redactSensitive({ Api_Key: "x".repeat(25), mySecretValue: "y".repeat(25) });
    expect(out.Api_Key).toBe(REDACTED);
    expect(out.mySecretValue).toBe(REDACTED);
  });

  it("leaves innocent keys alone", () => {
    const ctx = { taskId: "TASK-1", agent: "builder", count: 3, note: "all good" };
    expect(redactSensitive(ctx)).toEqual(ctx);
  });
});

describe("redactSensitive — value-shape based", () => {
  it("redacts a fake provider API key under an innocuous key (acceptance proof)", () => {
    const out = redactSensitive({ config: FAKE_API_KEY });
    expect(JSON.stringify(out)).not.toContain(FAKE_API_KEY);
    expect((out.config as string)).toBe(REDACTED);
  });

  it("redacts prefixed key shapes (sk-, ghp_, sk-ant-, sbp_)", () => {
    const shapes = {
      a: "sk-ant-api03-abcdef1234567890abcdef",
      b: "ghp_1234567890abcdefghijklmnopqrstuvwxyz",
      c: "sbp_test_0123456789abcdef",
      d: "github_pat_11AAAAAAA0abcdefghijklmnop",
    };
    const out = redactSensitive(shapes);
    for (const v of Object.values(out)) expect(v).toBe(REDACTED);
  });

  it("redacts Authorization-header style values", () => {
    expect(redactSensitive({ header: "Bearer eyJhbGciOiJIUzI1NiJ9" }).header).toBe(REDACTED);
    expect(redactSensitive({ header: "Basic dXNlcjpwYXNz" }).header).toBe(REDACTED);
  });

  it("redacts long opaque alphanumerics but keeps prose and ids", () => {
    const out = redactSensitive({
      opaque: "Abc123Def456Ghi789Jkl0",
      prose: "the quick brown fox jumps",
      id: "task-123",
      numeric: 12345,
      short: "abc123",
    });
    expect(out.opaque).toBe(REDACTED);
    expect(out.prose).toBe("the quick brown fox jumps");
    expect(out.id).toBe("task-123");
    expect(out.numeric).toBe(12345);
    expect(out.short).toBe("abc123");
  });

  it("scrubs inside nested objects and arrays without mutating input", () => {
    const input = { nested: { apiKey: FAKE_API_KEY }, list: [{ token: "tok_123456" }] };
    const snapshot = JSON.stringify(input);
    const out = redactSensitive(input);
    expect(JSON.stringify(out)).not.toContain(FAKE_API_KEY);
    expect(JSON.stringify(out)).not.toContain("tok_123456");
    expect(JSON.stringify(out)).not.toContain(REDACTED + REDACTED);
    // Input untouched.
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it("keeps undefined/null sensitive values as-is", () => {
    const out = redactSensitive({ apiKey: undefined, token: null });
    expect(out.apiKey).toBeUndefined();
    expect(out.token).toBeNull();
  });
});

describe("applyRedaction", () => {
  it("runs custom hooks then the built-in scrub", () => {
    const dropStory: (ctx: Record<string, unknown>) => Record<string, unknown> = (ctx) => {
      const { story, ...rest } = ctx;
      void story;
      return { ...rest, story: "[removed]" };
    };
    const out = applyRedaction(
      { story: "once upon a time", apiKey: FAKE_API_KEY } as never,
      [dropStory as never],
    );
    expect(out.story).toBe("[removed]");
    expect(JSON.stringify(out)).not.toContain(FAKE_API_KEY);
  });
});

describe("logger redaction end-to-end (acceptance: fake key never reaches output)", () => {
  it("fake API key never appears in any emitted line", () => {
    const lines: string[] = [];
    const sink = (_r: LogRecord, line: string) => lines.push(line);
    const log = createLogger({
      level: "debug",
      sink,
      context: { taskId: "TASK-CORE-012", agent: "builder" },
    });

    log.info("config loaded", { apiKey: FAKE_API_KEY, kie_api_key: FAKE_API_KEY });
    log.warn("request failed", { headers: { Authorization: `Bearer ${FAKE_API_KEY}` } });
    log.error("provider rejected", { body: { key: FAKE_API_KEY } });
    log.debug("raw", { value: FAKE_API_KEY });

    const all = lines.join("\n");
    expect(lines.length).toBe(4);
    expect(all).not.toContain(FAKE_API_KEY);
    expect(all).toContain(REDACTED);
    // Structure fields survive redaction.
    const first = JSON.parse(lines[0]!) as LogRecord;
    expect(first.level).toBe("info");
    expect(first.message).toBe("config loaded");
    expect(first.context.taskId).toBe("TASK-CORE-012");
    expect(first.context.agent).toBe("builder");
    expect(first.context.apiKey).toBe(REDACTED);
  });

  it("bound context containing a key-shaped value is scrubbed too", () => {
    const lines: string[] = [];
    const sink = (_r: LogRecord, line: string) => lines.push(line);
    const log = createLogger({
      sink,
      context: { AGNES_API_KEY: FAKE_API_KEY, agent: "provider" },
    });
    log.info("bound secret");
    expect(lines.join("")).not.toContain(FAKE_API_KEY);
    expect(lines.join("")).toContain(REDACTED);
  });
});