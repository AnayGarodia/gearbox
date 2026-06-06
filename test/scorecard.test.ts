import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoutingSelector } from "../src/model/router.ts";
import { scorecardRows } from "../src/commands.ts";

const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ["ANTHROPIC_API_KEY", "DEEPSEEK_API_KEY", "GEARBOX_HOME"]) saved[k] = process.env[k];
  process.env.GEARBOX_HOME = mkdtempSync(join(tmpdir(), "gearbox-card-"));
  process.env.ANTHROPIC_API_KEY = "k";
  process.env.DEEPSEEK_API_KEY = "k";
});
afterEach(() => {
  for (const k of ["ANTHROPIC_API_KEY", "DEEPSEEK_API_KEY", "GEARBOX_HOME"]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
});

test("explain() ranks candidates, marks exactly one chosen, and it matches select()", () => {
  const r = new RoutingSelector();
  const task = { prompt: "refactor the parser" };
  const card = r.explain(task);
  const chosen = card.entries.filter((e) => e.chosen);
  expect(chosen.length).toBe(1);
  expect(chosen[0]!.label).toBe(r.select(task).model.label); // scorecard agrees with the real pick
  expect(card.kind).toBe("code");
  expect(card.bar).toBeCloseTo(0.7, 5);
});

test("below-bar candidates are shown but never chosen, with provenance tags", () => {
  const card = new RoutingSelector().explain({ prompt: "refactor the parser" });
  const haiku = card.entries.find((e) => e.label.includes("haiku"));
  expect(haiku?.verdict).toBe("below bar"); // haiku quality < 0.7
  expect(haiku?.chosen).toBe(false);
  // every entry carries a provenance abbreviation
  for (const e of card.entries) expect(["measured", "researched", "seeded"]).toContain(e.qualitySrc);
});

test("scorecardRows renders a title, a column header, and one row per candidate", () => {
  const card = new RoutingSelector().explain({ prompt: "refactor the parser" });
  const rows = scorecardRows(card);
  expect(rows[0]!.tone).toBe("title");
  expect(rows.some((r) => r.tone === "colhead")).toBe(true);
  expect(rows.some((r) => r.tone === "chosen" && r.text.includes("◀"))).toBe(true);
});
