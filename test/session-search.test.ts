/**
 * Cross-session search (src/session-search.ts).
 *
 * Handcrafted session JSON files in a temp GEARBOX_HOME (same
 * sessions/<project-slug>/ layout session.ts writes — slug re-derived with
 * the identical expression). No API keys, no UI.
 */
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { searchSessions, highlightRanges } from "../src/session-search.ts";

// Same slug derivation as session.ts (not exported there).
const slug = () =>
  process.cwd().replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "root";

let home: string;
let dir: string; // the project's session dir under the temp GEARBOX_HOME
let prevHome: string | undefined;

beforeEach(() => {
  prevHome = process.env.GEARBOX_HOME;
  home = mkdtempSync(join(tmpdir(), "gearbox-search-"));
  process.env.GEARBOX_HOME = home;
  dir = join(home, "sessions", slug());
  mkdirSync(dir, { recursive: true });
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.GEARBOX_HOME;
  else process.env.GEARBOX_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

// ── fixtures ──────────────────────────────────────────────────────────────────

const user = (text: string) => ({ role: "user", content: text });
const assistant = (text: string) => ({
  role: "assistant",
  content: [{ type: "text", text }],
});
const turn = { model: "m", inputTokens: 1, outputTokens: 1, at: 1 };

/** Writes a session file and pins its mtime (defaults to updatedAt). */
function writeSession(
  s: { id: string } & Record<string, unknown>,
  into: string = dir,
  mtimeMs?: number,
) {
  const full = {
    cwd: "/x",
    createdAt: 1_000,
    updatedAt: 1_000_000,
    title: "",
    messages: [],
    items: [],
    turns: [],
    ...s,
  };
  const path = join(into, `${s.id}.json`);
  writeFileSync(path, JSON.stringify(full));
  const t = new Date(mtimeMs ?? (full.updatedAt as number));
  utimesSync(path, t, t);
}

// ── basics ────────────────────────────────────────────────────────────────────

test("finds a match and returns id/title/updatedAt/turns metadata", () => {
  writeSession({
    id: "s1",
    title: "refactor the tokenizer",
    updatedAt: 5_000_000,
    turns: [turn, turn, turn],
    messages: [user("please refactor it"), assistant("done")],
  });
  const r = searchSessions("tokenizer");
  expect(r.length).toBe(1);
  expect(r[0]!.id).toBe("s1");
  expect(r[0]!.title).toBe("refactor the tokenizer");
  expect(r[0]!.updatedAt).toBe(5_000_000);
  expect(r[0]!.turns).toBe(3);
  expect(r[0]!.score).toBeGreaterThan(0);
});

test("empty/whitespace query and missing dir both return []", () => {
  writeSession({ id: "s1", title: "anything" });
  expect(searchSessions("")).toEqual([]);
  expect(searchSessions("   ")).toEqual([]);
  expect(searchSessions("anything", { dir: join(home, "nope") })).toEqual([]);
});

test("opts.dir overrides the scan directory", () => {
  const other = join(home, "elsewhere");
  mkdirSync(other, { recursive: true });
  writeSession({ id: "sx", title: "zebra session" }, other);
  expect(searchSessions("zebra").length).toBe(0); // not in the project dir
  const r = searchSessions("zebra", { dir: other });
  expect(r.length).toBe(1);
  expect(r[0]!.id).toBe("sx");
});

// ── ranking ───────────────────────────────────────────────────────────────────

test("ranking: title match > user-message match > assistant match", () => {
  // Same updatedAt/mtime so field weight alone decides the order.
  writeSession({ id: "in-assistant", messages: [assistant("the gadget broke")] });
  writeSession({ id: "in-user", messages: [user("fix the gadget")] });
  writeSession({ id: "in-title", title: "gadget polish" });
  const r = searchSessions("gadget");
  expect(r.map((m) => m.id)).toEqual(["in-title", "in-user", "in-assistant"]);
});

test("newer session floats up on score ties", () => {
  writeSession({ id: "older", updatedAt: 1_000_000, messages: [user("same widget ask")] });
  writeSession({ id: "newer", updatedAt: 2_000_000, messages: [user("same widget ask")] });
  const r = searchSessions("widget");
  expect(r.map((m) => m.id)).toEqual(["newer", "older"]);
});

test("more matches outrank fewer within the same field", () => {
  // Give the sparse session the NEWER timestamp so count, not recency, wins.
  writeSession({
    id: "sparse",
    updatedAt: 2_000_000,
    messages: [assistant("flux mentioned once")],
  });
  writeSession({
    id: "dense",
    updatedAt: 1_000_000,
    messages: [assistant("flux flux flux everywhere flux")],
  });
  const r = searchSessions("flux");
  expect(r.map((m) => m.id)).toEqual(["dense", "sparse"]);
});

test("occurrence volume never flips the field ranking", () => {
  // A single user-message hit must still beat an assistant message that
  // repeats the word many times (the count bonus is capped below the gap).
  writeSession({ id: "one-user-hit", updatedAt: 1_000_000, messages: [user("spark once")] });
  writeSession({
    id: "many-assistant-hits",
    updatedAt: 2_000_000,
    messages: [assistant(Array(50).fill("spark").join(" "))],
  });
  const r = searchSessions("spark");
  expect(r.map((m) => m.id)).toEqual(["one-user-hit", "many-assistant-hits"]);
});

// ── multi-word queries ────────────────────────────────────────────────────────

test("AND semantics: every word must appear somewhere in the session", () => {
  writeSession({ id: "both", messages: [user("alpha here"), assistant("bravo there")] });
  writeSession({ id: "only-alpha", messages: [user("alpha alone")] });
  const r = searchSessions("alpha bravo");
  expect(r.map((m) => m.id)).toEqual(["both"]);
});

test("snippet shows the rarest word's best line", () => {
  writeSession({
    id: "s1",
    messages: [
      user("alpha alpha alpha all over"),
      assistant("the bravo line is here"),
    ],
  });
  const r = searchSessions("alpha bravo");
  expect(r.length).toBe(1);
  // bravo (1 occurrence) is rarer than alpha (3) → its line is the snippet.
  expect(r[0]!.snippet).toBe("the bravo line is here");
});

// ── snippet shape ─────────────────────────────────────────────────────────────

test("snippet centers the match ±40 chars with ellipses on clipped sides", () => {
  const line = "a".repeat(60) + "needle" + "b".repeat(60);
  writeSession({ id: "s1", messages: [user(line)] });
  const r = searchSessions("needle");
  const snip = r[0]!.snippet;
  expect(snip.startsWith("…")).toBe(true);
  expect(snip.endsWith("…")).toBe(true);
  expect(snip.length).toBe(1 + 40 + "needle".length + 40 + 1);
  expect(snip.indexOf("needle")).toBe(1 + 40); // centered after the ellipsis
});

test("short lines are returned whole, with no ellipses", () => {
  writeSession({ id: "s1", title: "needle at the start" });
  const r = searchSessions("needle");
  expect(r[0]!.snippet).toBe("needle at the start");
});

test("matching is case-insensitive in both query and content", () => {
  writeSession({ id: "s1", title: "Fix The PARSER" });
  const r = searchSessions("parser");
  expect(r.length).toBe(1);
  expect(searchSessions("FIX parser").length).toBe(1);
});

// ── robustness ────────────────────────────────────────────────────────────────

test("corrupt and shape-invalid files are skipped silently", () => {
  writeSession({ id: "good", title: "find the keyword" });
  writeFileSync(join(dir, "corrupt.json"), "{ this is not json !!!");
  writeFileSync(join(dir, "wrong-shape.json"), JSON.stringify([1, 2, 3]));
  writeFileSync(join(dir, "no-id.json"), JSON.stringify({ title: "keyword too" }));
  const r = searchSessions("keyword");
  expect(r.map((m) => m.id)).toEqual(["good"]);
});

test("history.json is never treated as a session", () => {
  writeFileSync(join(dir, "history.json"), JSON.stringify(["secret keyword prompt"]));
  expect(searchSessions("keyword")).toEqual([]);
});

// ── limit + bail-early ────────────────────────────────────────────────────────

test("limit caps results to the top-ranked sessions", () => {
  for (let i = 1; i <= 5; i++) {
    writeSession({ id: `s${i}`, updatedAt: i * 1_000_000, messages: [user("common term")] });
  }
  const r = searchSessions("common", { limit: 3 });
  expect(r.map((m) => m.id)).toEqual(["s5", "s4", "s3"]); // newest first on ties
});

test("bails past limit*4 candidates sorted by mtime descending", () => {
  // 4 newer user-field matches fill the scan window (limit 1 → scan 4 files);
  // the OLDEST file is a title match that would win — but is never scanned.
  writeSession({ id: "old-title-hit", title: "common gold", updatedAt: 1_000 }, dir, 1_000);
  for (let i = 1; i <= 4; i++) {
    writeSession(
      { id: `new${i}`, updatedAt: i * 1_000_000, messages: [user("common stuff")] },
      dir,
      i * 1_000_000,
    );
  }
  const r = searchSessions("common", { limit: 1 });
  expect(r.length).toBe(1);
  expect(r[0]!.id).toBe("new4"); // newest user match, NOT the unscanned title hit
});

// ── highlightRanges ───────────────────────────────────────────────────────────

test("highlightRanges finds case-insensitive ranges for every query word", () => {
  expect(highlightRanges("Fix the FooBar parser", "foobar parser")).toEqual([
    { start: 8, end: 14 },
    { start: 15, end: 21 },
  ]);
});

test("highlightRanges reports repeated occurrences", () => {
  expect(highlightRanges("ping pong ping", "ping")).toEqual([
    { start: 0, end: 4 },
    { start: 10, end: 14 },
  ]);
});

test("highlightRanges merges overlapping ranges", () => {
  // "abc" hits at 0 and 3; "bca" hits at 2 — all overlap into one range.
  expect(highlightRanges("abcabc", "abc bca")).toEqual([{ start: 0, end: 6 }]);
});

test("highlightRanges returns [] for empty inputs", () => {
  expect(highlightRanges("", "word")).toEqual([]);
  expect(highlightRanges("some text", "")).toEqual([]);
  expect(highlightRanges("some text", "   ")).toEqual([]);
});
