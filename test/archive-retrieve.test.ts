import { test, expect } from "bun:test";
import type { CompactionArchive } from "../src/session.ts";
import { retrieveArchives } from "../src/context/archive-retrieve.ts";

const archive = (id: string, summary: string, body: string): CompactionArchive => ({
  id,
  at: id === "new" ? 2 : 1,
  turns: { start: 1, end: 2 },
  instruction: summary,
  summary,
  messages: [
    { role: "user", content: body },
    { role: "assistant", content: `noted ${body}` },
  ],
});

test("retrieveArchives returns matching compacted session archives", () => {
  const hits = retrieveArchives("continue auth token expiry fix", [
    archive("auth", "authentication token expiry work", "changed src/accounts/health.ts and ran bun test test/health.test.ts"),
    archive("theme", "theme palette cleanup", "changed src/ui/theme.ts"),
  ]);
  expect(hits.map((h) => h.archiveId)).toContain("auth");
  expect(hits.map((h) => h.archiveId)).not.toContain("theme");
  expect(hits[0]!.excerpt).toContain("src/accounts/health.ts");
});

test("retrieveArchives respects token budget", () => {
  const hits = retrieveArchives("auth", [archive("auth", "auth ".repeat(1000), "auth details")], 3, 10);
  expect(hits).toEqual([]);
});

test("retrieveArchives returns nothing for unrelated prompts", () => {
  expect(retrieveArchives("render markdown table", [
    archive("auth", "authentication token expiry work", "src/accounts/health.ts"),
  ])).toEqual([]);
});

test("retrieveArchives includes structured provenance for graph matches", () => {
  const a = archive("graph", "Sparse summary", "older task");
  a.structured = {
    goals: [],
    decisions: [],
    files: [{ path: "src/context/archive-retrieve.ts", change: "recall compacted archive by file provenance" }],
    commands: [],
    facts: [],
    openThreads: [],
    topics: [{ title: "archive recall", notes: [], files: ["src/context/archive-retrieve.ts"] }],
  };
  const hits = retrieveArchives("why archive-retrieve.ts changed", [a]);
  expect(hits[0]!.archiveId).toBe("graph");
  expect(hits[0]!.provenance).toContain("file: src/context/archive-retrieve.ts");
});
