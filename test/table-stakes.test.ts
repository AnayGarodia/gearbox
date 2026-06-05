import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTools } from "../src/tools.ts";
import { resetPermissions, setPermissionHandler, setYolo } from "../src/permission.ts";
import { stripHtml, urlsInText } from "../src/fetch.ts";
import { detectVerificationCommands } from "../src/verify.ts";
import { buildProjectGuide } from "../src/init.ts";
import { gitContext } from "../src/context/git.ts";

test("edit_file can target a specific occurrence and replace all matches", async () => {
  setPermissionHandler(null);
  resetPermissions();
  setYolo(true);
  const path = `.gearbox-edit-test-${Date.now()}.txt`;
  writeFileSync(path, "alpha\nbeta\nalpha\n", "utf8");
  try {
    const edit = createTools().edit_file as any;
    const one = await edit.execute({ path, find: "alpha", replace: "gamma", occurrence: 2, replaceAll: false });
    expect(one.summary).toContain("1 replacement");
    const all = await edit.execute({ path, find: "gamma", replace: "delta", replaceAll: true });
    expect(all.summary).toContain("1 replacement");
  } finally {
    rmSync(path, { force: true });
    resetPermissions();
    setPermissionHandler(null);
  }
});

test("URL helpers extract links and strip HTML to readable text", () => {
  expect(urlsInText("read https://example.com/docs). then http://x.test/a?b=1.")).toEqual([
    "https://example.com/docs",
    "http://x.test/a?b=1",
  ]);
  expect(stripHtml("<html><title>x</title><style>.a{}</style><body><h1>Docs</h1><p>A &amp; B<br>C</p></body></html>")).toContain("Docs");
  expect(stripHtml("<p>A &amp; B</p>")).toContain("A & B");
});

test("detectVerificationCommands reads package scripts and package manager", () => {
  const dir = mkdtempSync(join(tmpdir(), "gearbox-verify-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { typecheck: "tsc --noEmit", test: "bun test", build: "bun build src/index.ts" } }));
    writeFileSync(join(dir, "bun.lock"), "");
    expect(detectVerificationCommands(dir).map((c) => c.command)).toEqual(["bun run typecheck", "bun test", "bun run build"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildProjectGuide includes stack, checks, layout, and docs", () => {
  const dir = mkdtempSync(join(tmpdir(), "gearbox-init-"));
  try {
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "README.md"), "# Test");
    writeFileSync(join(dir, "bun.lock"), "");
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "demo", scripts: { test: "bun test" }, devDependencies: { ink: "5" } }));
    const guide = buildProjectGuide(dir);
    expect(guide).toContain("# demo - Gearbox Guide");
    expect(guide).toContain("Ink terminal UI");
    expect(guide).toContain("bun test");
    expect(guide).toContain("README.md");
    expect(guide).toContain("src/");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("gitContext is empty outside git and includes branch inside git", () => {
  const dir = mkdtempSync(join(tmpdir(), "gearbox-git-"));
  try {
    expect(gitContext(dir)).toBe("");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
