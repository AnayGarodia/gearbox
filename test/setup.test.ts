// Per-tab setup script detection. `.gearbox/setup` (committed, so it rides into
// every worktree) is run in the background to bootstrap a fresh worktree.
import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasSetup, setupScriptPath } from "../src/setup.ts";

const made: string[] = [];
const mkRepo = (): string => {
  const d = mkdtempSync(join(tmpdir(), "gearbox-setup-"));
  made.push(d);
  return d;
};
afterEach(() => { while (made.length) rmSync(made.pop()!, { recursive: true, force: true }); });

test("hasSetup is false with no .gearbox/setup", () => {
  expect(hasSetup(mkRepo())).toBe(false);
});

test("hasSetup is true once .gearbox/setup exists", () => {
  const root = mkRepo();
  mkdirSync(join(root, ".gearbox"), { recursive: true });
  writeFileSync(setupScriptPath(root), "#!/bin/sh\necho hi\n");
  expect(hasSetup(root)).toBe(true);
});

test("hasSetup is false when .gearbox/setup is a directory, not a file", () => {
  const root = mkRepo();
  mkdirSync(setupScriptPath(root), { recursive: true });
  expect(hasSetup(root)).toBe(false);
});
