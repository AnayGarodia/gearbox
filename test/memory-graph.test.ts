import { test, expect } from "bun:test";
import type { CompactionArchive } from "../src/session.ts";
import { retrieveArchives } from "../src/context/archive-retrieve.ts";
import { buildMemoryGraph, memoryGraphArchiveBoost } from "../src/context/memory-graph.ts";

const archive: CompactionArchive = {
  id: "ctx",
  at: 10,
  turns: { start: 3, end: 7 },
  instruction: "old work",
  summary: "Sparse summary",
  messages: [{ role: "user", content: "continue" }],
  structured: {
    goals: ["improve context recall"],
    decisions: ["use graph provenance for compacted memory"],
    files: [{ path: "src/context/memory-graph.ts", change: "added archive provenance nodes" }],
    commands: [{ command: "bun test test/memory-graph.test.ts", outcome: "passed" }],
    facts: ["graph nodes stay linked to the original compacted turn range"],
    openThreads: [],
    topics: [
      {
        title: "provenance memory",
        notes: ["archive recall should work through structured topics"],
        files: ["src/context/archive-retrieve.ts"],
      },
    ],
  },
  verification: {
    ok: false,
    missingFiles: ["src/context/compact.ts"],
    missingCommands: [],
    missingFailures: [],
    missingConstraints: ["must preserve reversible pointers"],
    patch: ["src/context/compact.ts was part of the compaction flow"],
  },
};

test("buildMemoryGraph links compacted archives to provenance nodes", () => {
  const graph = buildMemoryGraph([archive]);
  expect(graph.nodes.get("archive:ctx")?.meta).toEqual({ start: "3", end: "7" });
  expect([...graph.nodes.values()].some((n) => n.kind === "file" && n.text === "src/context/memory-graph.ts")).toBe(true);
  expect([...graph.nodes.values()].some((n) => n.kind === "topic" && n.text === "provenance memory")).toBe(true);
  expect([...graph.nodes.values()].some((n) => n.kind === "command" && n.text === "bun test test/memory-graph.test.ts")).toBe(true);
  expect(graph.edges.some((e) => e.kind === "summarizes" && e.to === "archive:ctx")).toBe(true);
  expect(graph.edges.some((e) => e.kind === "patched")).toBe(true);
});

test("memoryGraphArchiveBoost scores structured archive provenance", () => {
  expect(memoryGraphArchiveBoost(["archive-retrieve.ts"], archive)).toBeGreaterThan(0);
  expect(memoryGraphArchiveBoost(["provenance", "memory"], archive)).toBeGreaterThan(0);
  expect(memoryGraphArchiveBoost(["unrelated"], archive)).toBe(0);
});

test("retrieveArchives can recall graph-only structured matches", () => {
  const hits = retrieveArchives("why did archive-retrieve.ts change", [archive]);
  expect(hits.map((h) => h.archiveId)).toEqual(["ctx"]);
  expect(hits[0]!.summary).toBe("Sparse summary");
});
