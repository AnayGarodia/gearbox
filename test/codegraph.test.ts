import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { codeGraph, graphBoostForFile, resetCodeGraph } from "../src/context/codegraph.ts";
import { rankFiles, resetRetrievalIndex } from "../src/context/retrieve.ts";
import { invalidateFileListCache } from "../src/ui/files.ts";

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "gearbox-codegraph-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src/service.ts"), "export function issueToken() { return 'token'; }\n");
  writeFileSync(join(dir, "src/caller.ts"), "import { issueToken } from './service';\nexport function login() { return issueToken(); }\n");
  writeFileSync(join(dir, "src/other.ts"), "export function renderTheme() { return 'blue'; }\n");
  return dir;
}

test("codeGraph records definitions, imports, and importers", () => {
  const cwd = repo();
  try {
    invalidateFileListCache();
    resetCodeGraph();
    const graph = codeGraph(cwd);
    expect(graph.files.get("src/service.ts")?.defs).toContain("issuetoken");
    expect(graph.files.get("src/caller.ts")?.importedFiles).toContain("src/service.ts");
    expect(graph.files.get("src/service.ts")?.importers).toContain("src/caller.ts");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("graphBoostForFile rewards callers on usage queries", () => {
  const cwd = repo();
  try {
    invalidateFileListCache();
    resetCodeGraph();
    const caller = graphBoostForFile(["caller", "issue", "token"], "src/caller.ts", cwd);
    const other = graphBoostForFile(["caller", "issue", "token"], "src/other.ts", cwd);
    expect(caller).toBeGreaterThan(other);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("rankFiles includes graph signal for caller queries", () => {
  const cwd = repo();
  try {
    invalidateFileListCache();
    resetCodeGraph();
    resetRetrievalIndex();
    const ranked = rankFiles("callers of issueToken", cwd).slice(0, 2).map((r) => r.file);
    expect(ranked).toContain("src/caller.ts");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
