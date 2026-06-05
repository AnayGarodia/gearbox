import { test, expect } from "bun:test";
import { runShellStream } from "../src/shell.ts";

test("runShellStream streams stdout and stderr before returning", async () => {
  const chunks: string[] = [];
  const r = await runShellStream("printf out; printf err >&2", {
    onChunk: (c) => chunks.push(`${c.stream}:${c.text}`),
  });
  expect(r.ok).toBe(true);
  expect(r.exitCode).toBe(0);
  expect(chunks.join("|")).toContain("stdout:out");
  expect(chunks.join("|")).toContain("stderr:err");
  expect(r.output).toContain("out");
  expect(r.output).toContain("err");
});

test("runShellStream reports failed commands with exit code", async () => {
  const r = await runShellStream("printf nope; exit 7");
  expect(r.ok).toBe(false);
  expect(r.exitCode).toBe(7);
  expect(r.output).toContain("exit 7");
  expect(r.output).toContain("nope");
});

