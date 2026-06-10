import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, utimesSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capToolOutput, differentiatingSlice, longestCommonPrefixLen, truncateOutput, spillOutput, gcSpills } from "../src/truncate.ts";

// ── truncateOutput ───────────────────────────────────────────────────────────

const numbered = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");

test("no truncation under both limits", () => {
  const text = numbered(10);
  const r = truncateOutput(text);
  expect(r.truncated).toBe(false);
  expect(r.text).toBe(text);
  expect(r.totalLines).toBe(10);
  expect(r.totalBytes).toBe(Buffer.byteLength(text));
});

test("line cap: head keeps the start and the notice names the counts + recovery move", () => {
  const r = truncateOutput(numbered(50), { maxLines: 10 });
  expect(r.truncated).toBe(true);
  expect(r.totalLines).toBe(50);
  expect(r.text.startsWith("line 1\n")).toBe(true);
  expect(r.text).toContain("line 10");
  expect(r.text).not.toContain("line 11\n");
  expect(r.text).toContain("[truncated: showing lines 1-10 of 50.");
  expect(r.text).toContain("offset=11");
  expect(r.text).toContain("search");
});

test("line cap: tail keeps the end and prepends the notice", () => {
  const r = truncateOutput(numbered(50), { maxLines: 10, direction: "tail" });
  expect(r.truncated).toBe(true);
  expect(r.text.startsWith("[truncated: showing last 10 of 50 lines.")).toBe(true);
  expect(r.text).toContain("line 41");
  expect(r.text.endsWith("line 50")).toBe(true);
  expect(r.text).not.toContain("line 40\n");
});

test("byte cap bites even when the line count is fine", () => {
  const text = Array.from({ length: 5 }, (_, i) => `${i}:${"x".repeat(100)}`).join("\n");
  const r = truncateOutput(text, { maxBytes: 250 });
  expect(r.truncated).toBe(true);
  expect(r.text).toContain("0:"); // head keeps the start
  expect(r.text).not.toContain("4:x");
  expect(Buffer.byteLength(r.text)).toBeLessThan(Buffer.byteLength(text));
});

test("byte cap, tail direction, keeps the end", () => {
  const text = Array.from({ length: 5 }, (_, i) => `${i}:${"x".repeat(100)}`).join("\n");
  const r = truncateOutput(text, { maxBytes: 250, direction: "tail" });
  expect(r.truncated).toBe(true);
  expect(r.text).toContain("4:");
  expect(r.text).not.toContain("0:x");
});

test("a single line over the byte budget is hard-sliced, not dropped", () => {
  const r = truncateOutput("y".repeat(1000), { maxBytes: 100 });
  expect(r.truncated).toBe(true);
  expect(r.text).toContain("y".repeat(100));
  expect(r.text).not.toContain("y".repeat(101));
});

test("spillPath is woven into the notice", () => {
  const r = truncateOutput(numbered(50), { maxLines: 10, spillPath: "/tmp/spill.txt" });
  expect(r.text).toContain("Full output: /tmp/spill.txt.");
  const tail = truncateOutput(numbered(50), { maxLines: 10, direction: "tail", spillPath: "/tmp/spill.txt" });
  expect(tail.text).toContain("Full output: /tmp/spill.txt.");
});

test("capToolOutput matches the truncateOutput(spillPath) text exactly, both directions", () => {
  const home = mkdtempSync(join(tmpdir(), "gearbox-cap-"));
  const prev = process.env.GEARBOX_HOME;
  process.env.GEARBOX_HOME = home;
  try {
    const text = numbered(50);
    for (const direction of ["head", "tail"] as const) {
      const capped = capToolOutput("cap-test", text, { maxLines: 10, direction });
      const m = capped.match(/Full output: (\S+\.txt)\./);
      expect(m).toBeTruthy(); // spill path woven into the notice
      expect(readFileSync(m![1]!, "utf8")).toBe(text); // full text spilled
      // The spliced notice is byte-for-byte what the two-pass version produced.
      expect(capped).toBe(truncateOutput(text, { maxLines: 10, direction, spillPath: m![1]! }).text);
    }
    // Under the caps: returned untouched, no spill.
    expect(capToolOutput("cap-test", "small")).toBe("small");
  } finally {
    if (prev === undefined) delete process.env.GEARBOX_HOME;
    else process.env.GEARBOX_HOME = prev;
  }
});

// ── spillOutput / gcSpills ───────────────────────────────────────────────────

test("spillOutput writes the full text under GEARBOX_HOME/tool-outputs and gcSpills reaps old files", () => {
  const home = mkdtempSync(join(tmpdir(), "gearbox-spill-"));
  const prev = process.env.GEARBOX_HOME;
  process.env.GEARBOX_HOME = home;
  try {
    const path = spillOutput("run-shell", "the full output");
    expect(path).toBeTruthy();
    expect(path!).toContain(join(home, "tool-outputs"));
    expect(readFileSync(path!, "utf8")).toBe("the full output");

    // age a file past the cutoff and gc it
    const old = join(home, "tool-outputs", "old-spill.txt");
    writeFileSync(old, "stale");
    const past = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    utimesSync(old, past, past);
    gcSpills();
    const left = readdirSync(join(home, "tool-outputs"));
    expect(left).not.toContain("old-spill.txt");
    expect(left.length).toBe(1); // the fresh spill survives
  } finally {
    if (prev === undefined) delete process.env.GEARBOX_HOME;
    else process.env.GEARBOX_HOME = prev;
  }
});

// ── differentiating truncation ───────────────────────────────────────────────

test("longestCommonPrefixLen finds the shared prefix length", () => {
  expect(longestCommonPrefixLen(["abcd", "abce"])).toBe(3);
  expect(longestCommonPrefixLen(["abc", "xyz"])).toBe(0);
  expect(longestCommonPrefixLen(["only one"])).toBe(0);
});

test("differentiatingSlice shows the VARYING tail when siblings share a long prefix", () => {
  const tasks = [
    "You are doing a COMMENT CLEANUP PASS only — no logic in src/agent/run.ts",
    "You are doing a COMMENT CLEANUP PASS only — no logic in src/ui/App.tsx",
    "You are doing a COMMENT CLEANUP PASS only — no logic in src/model/router.ts",
  ];
  const a = differentiatingSlice(tasks, 0, 40);
  const b = differentiatingSlice(tasks, 1, 40);
  expect(a).toContain("run.ts");
  expect(b).toContain("App.tsx");
  expect(a).not.toBe(b); // the whole point: distinguishable
  expect(a).not.toContain("COMMENT CLEANUP"); // shared prefix dropped
});

test("differentiatingSlice falls back to the (clipped) task when siblings are identical", () => {
  const same = ["fix the auth bug", "fix the auth bug"];
  expect(differentiatingSlice(same, 0, 40)).toBe("fix the auth bug");
});

test("a single string just gets word-boundary clipped", () => {
  expect(differentiatingSlice(["short task"], 0, 40)).toBe("short task");
  expect(differentiatingSlice(["a very long task description that keeps going well past the limit"], 0, 20)).toMatch(/…$/);
});
