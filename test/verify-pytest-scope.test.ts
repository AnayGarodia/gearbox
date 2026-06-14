import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectVerificationCommands } from "../src/verify.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "gb-verify-"));
const pytest = (cwd: string, changed: string[]) =>
  detectVerificationCommands(cwd, changed).find((c) => c.command.includes("pytest"))?.command;

test("markerless parent dir: pytest is scoped to the changed dirs (not the whole tree)", () => {
  // The reported bug: gearbox run in ~/Desktop/Projects (no pyproject), change
  // only under mathlib/ — pytest must NOT sweep sibling repos like CAIAC.
  const cwd = tmp();
  const cmd = pytest(cwd, ["mathlib/mathlib.py", "mathlib/test_mathlib.py"]);
  expect(cmd).toBe('pytest -- "mathlib"');
});

test("real project root (pyproject.toml present): bare pytest, full project", () => {
  const cwd = tmp();
  writeFileSync(join(cwd, "pyproject.toml"), "[tool.pytest.ini_options]\n");
  const cmd = pytest(cwd, ["src/foo.py"]);
  expect(cmd).toBe("pytest"); // unscoped — the project root is correct scope
});

test("multiple changed dirs are all included", () => {
  const cwd = tmp();
  const cmd = pytest(cwd, ["a/x.py", "b/y.py", "a/z.py"]);
  expect(cmd).toBe('pytest -- "a" "b"');
});

test("a .py changed directly in a markerless cwd stays bare (dir is cwd)", () => {
  const cwd = tmp();
  const cmd = pytest(cwd, ["solo.py"]);
  expect(cmd).toBe("pytest");
});

test("paths with shell metacharacters are dropped (no command injection)", () => {
  const cwd = tmp();
  // A maliciously-named dir must never reach the shell string.
  const cmd = pytest(cwd, ['evil"; rm -rf ~; "/x.py', "good/y.py"]);
  expect(cmd).toBe('pytest -- "good"'); // the evil dir is filtered out
  expect(cmd).not.toContain("rm -rf");

  // If ALL changed dirs are unsafe, fall back to a bare run — never inject.
  const cmd2 = pytest(cwd, ['$(touch pwned)/a.py', "`id`/b.py"]);
  expect(cmd2).toBe("pytest");
});
