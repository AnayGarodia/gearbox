import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newSessionId, saveSession, loadSession, listSessions, latestSession, loadHistory, appendHistory, type Session } from "../src/session.ts";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "gearbox-test-"));
  process.env.GEARBOX_HOME = home;
});
afterEach(() => {
  delete process.env.GEARBOX_HOME;
  rmSync(home, { recursive: true, force: true });
});

const mk = (id: string, title: string, updatedAt: number): Session => ({
  id,
  cwd: process.cwd(),
  createdAt: updatedAt,
  updatedAt,
  title,
  messages: [{ role: "user", content: title }],
  items: [{ kind: "user", id: 1, text: title }],
  turns: [{ model: "sonnet-4.6", inputTokens: 10, outputTokens: 20, at: updatedAt }],
});

test("save → load round-trips the full record (messages, items, turns)", () => {
  const s = mk(newSessionId(), "fix the auth bug", Date.now());
  saveSession(s);
  const back = loadSession(s.id);
  expect(back).not.toBeNull();
  expect(back!.title).toBe("fix the auth bug");
  expect(back!.messages.length).toBe(1);
  expect(back!.items.length).toBe(1);
  expect(back!.turns[0]!.model).toBe("sonnet-4.6");
  expect(back!.turns[0]!.outputTokens).toBe(20);
});

test("listSessions is newest-first; latestSession is the newest", () => {
  saveSession(mk("a", "older", 1000));
  saveSession(mk("b", "newer", 2000));
  const list = listSessions();
  expect(list.map((s) => s.id)).toEqual(["b", "a"]);
  expect(latestSession()!.id).toBe("b");
});

test("prompt history persists and dedupes consecutive entries", () => {
  expect(loadHistory()).toEqual([]);
  appendHistory("one");
  appendHistory("one"); // dedup
  appendHistory("two");
  expect(loadHistory()).toEqual(["one", "two"]);
});

test("loadSession returns null for a missing id", () => {
  expect(loadSession("nope")).toBeNull();
});
