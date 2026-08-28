/// <reference types="node" />
/**
 * Minimal child-process runner for the rough-cut fixture layer.
 *
 * Never executes story/script text (spec §29: untrusted data is never
 * executed): arguments are a fixed, programmatic list; the file path is the
 * only variable. Failures return structured results instead of throwing so
 * callers decide the error surface (the VID-014 final-render spawn pattern).
 */

import { spawn } from "node:child_process";

export interface SpawnResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface SpawnOptions {
  timeoutMs?: number;
  /** When true, a nonzero exit resolves normally instead of rejecting. */
  allowNonZero?: boolean;
}

export function spawnFile(
  file: string,
  args: readonly string[],
  options: SpawnOptions = {},
): Promise<SpawnResult> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  return new Promise((resolve, reject) => {
    const child = spawn(file, [...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`${file} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const result: SpawnResult = {
        code: code ?? -1,
        stdout,
        stderr,
      };
      if (result.code !== 0 && !options.allowNonZero) {
        reject(new Error(`${file} exited ${result.code}: ${stderr.slice(0, 400)}`));
        return;
      }
      resolve(result);
    });
  });
}
