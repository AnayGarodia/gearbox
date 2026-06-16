import { test, expect } from "bun:test";
import { itemsToLines } from "../src/ui/lines.ts";
import { WORKING_VERBS } from "../src/ui/character.ts";
import type { Item } from "../src/ui/types.ts";

const textOf = (lines: ReturnType<typeof itemsToLines>) => lines.map((line) => line.map((s) => s.text).join("")).join("\n");

test("missing inferred read paths collapse into one transcript fact", () => {
  const items: Item[] = [
    { kind: "tool", id: 1, callId: "a", name: "read_file", arg: "tests/test_elo.py", status: "err", summary: "Error: ENOENT: no such file or directory", startedAt: 1, endedAt: 2 },
    { kind: "tool", id: 2, callId: "b", name: "read_file", arg: "tests/test_poisson.py", status: "err", summary: "Error: ENOENT: no such file or directory", startedAt: 1, endedAt: 2 },
    { kind: "tool", id: 3, callId: "c", name: "read_file", arg: "tests/test_ensemble.py", status: "err", summary: "Error: ENOENT: no such file or directory", startedAt: 1, endedAt: 2 },
  ];
  const rendered = textOf(itemsToLines(items, 120));
  expect(rendered).toContain("3 missing reads");
  expect(rendered).toContain("test_elo.py, test_poisson.py, test_ensemble.py");
  expect(rendered).not.toContain("Error: ENOENT");
});

test("working verbs stay phase-specific, not mascot moods", () => {
  expect(WORKING_VERBS).toContain("Checking");
  expect(WORKING_VERBS).toContain("Verifying");
  expect(WORKING_VERBS).not.toContain("Ruminating");
});
