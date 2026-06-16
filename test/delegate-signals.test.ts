// Step 1 of proper delegation routing: a sub-task has no session history, so its
// difficulty signals (touchedFiles + estTokens) are sniffed from the task text.
// Without them a hard multi-file CODE sub-task and a one-line digest looked
// identical to the router. These cover the pure sniffer + the byte/token sizing,
// and prove the derived signals actually move the difficulty bar.
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTouchedFiles, deriveSubTaskSignals } from "../src/agent/delegate.ts";
import { estimateDifficulty } from "../src/model/difficulty.ts";

test("parseTouchedFiles pulls real paths and rejects prose / versions", () => {
  expect(parseTouchedFiles("fix the race condition in src/pool.ts and src/model/router.ts")).toEqual([
    "src/pool.ts",
    "src/model/router.ts",
  ]);
  // bare filenames with a known extension count; dirs-with-slash count.
  expect(parseTouchedFiles("update README.md and package.json")).toEqual(["README.md", "package.json"]);
  // non-files must NOT be mistaken for paths.
  expect(parseTouchedFiles("bump to v0.17.2 on claude-sonnet-4-6, e.g. for gpt-4.6")).toEqual([]);
  expect(parseTouchedFiles("summarize this diff")).toEqual([]);
  // a URL is not a local file.
  expect(parseTouchedFiles("scrape https://example.com/index.html for links")).toEqual([]);
});

test("parseTouchedFiles de-dupes, preserves order, and caps at 20", () => {
  expect(parseTouchedFiles("touch a.ts then a.ts again then b.ts")).toEqual(["a.ts", "b.ts"]);
  const many = Array.from({ length: 30 }, (_, i) => `f${i}/x.ts`).join(" ");
  expect(parseTouchedFiles(many).length).toBe(20);
});

test("deriveSubTaskSignals sizes estTokens from real file bytes, resolved against root", () => {
  const root = mkdtempSync(join(tmpdir(), "gearbox-sig-"));
  mkdirSync(join(root, "src"), { recursive: true });
  const big = "x".repeat(40_000); // ~10k tokens at 4 bytes/token
  writeFileSync(join(root, "src", "pool.ts"), big);

  const sig = deriveSubTaskSignals("fix the race condition in src/pool.ts", root);
  // path resolved to absolute under root so the router's statSync finds it.
  expect(sig.touchedFiles).toEqual([join(root, "src", "pool.ts")]);
  // instruction tokens + ~10k file tokens.
  expect(sig.estTokens).toBeGreaterThan(9_000);
});

test("a named-but-missing file still contributes a nominal working set", () => {
  // no root, file doesn't exist → nominal 2k tokens, not zero.
  const sig = deriveSubTaskSignals("refactor src/does-not-exist.ts");
  expect(sig.touchedFiles).toEqual(["src/does-not-exist.ts"]);
  expect(sig.estTokens).toBeGreaterThan(1_900);
});

test("the derived signals lift the difficulty bar for a hard sub-task above a digest", () => {
  const root = mkdtempSync(join(tmpdir(), "gearbox-sig2-"));
  mkdirSync(join(root, "src", "model"), { recursive: true });
  // three large, central-looking files
  for (const f of ["src/pool.ts", "src/model/router.ts", "src/model/scoring.ts"]) {
    writeFileSync(join(root, f), "y".repeat(60_000));
  }
  const hard = deriveSubTaskSignals(
    "fix the connection-pool race in src/pool.ts, src/model/router.ts, and src/model/scoring.ts",
    root,
  );
  const digest = deriveSubTaskSignals("summarize this diff");

  const dHard = estimateDifficulty({
    estTokens: hard.estTokens,
    touchedFileCount: hard.touchedFiles.length || undefined,
    touchedBytes: hard.touchedFiles.length ? 180_000 : undefined,
  }).d;
  const dDigest = estimateDifficulty({
    estTokens: digest.estTokens,
    touchedFileCount: digest.touchedFiles.length || undefined,
  }).d;

  expect(dHard).toBeGreaterThan(dDigest);
  expect(dDigest).toBe(0); // a one-line digest names no files → no difficulty bump
});
