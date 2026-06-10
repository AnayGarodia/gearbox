// Atomic-write hardening: every persisted file (prefs.json, history.json,
// accounts.json, credentials.enc, usage.json) is written via temp + rename,
// so a crash mid-write can never leave a torn file. These tests check the
// round-trip writes valid JSON and leaves no .tmp behind.
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "gbpersist-"));
process.env.GEARBOX_HOME = dir;

const noTmpLeft = (d: string) => existsSync(d) && readdirSync(d).every((f) => !f.endsWith(".tmp"));

test("savePrefs writes valid JSON atomically (no .tmp left behind)", async () => {
  const { savePrefs, loadPrefs } = await import("../src/ui/prefs.ts");
  savePrefs({ vim: true, theme: "dark" });
  expect(JSON.parse(readFileSync(join(dir, "prefs.json"), "utf8"))).toEqual({ vim: true, theme: "dark" });
  expect(loadPrefs().theme).toBe("dark");
  expect(noTmpLeft(dir)).toBe(true);
});

test("appendHistory round-trips and leaves no .tmp behind", async () => {
  const { appendHistory, loadHistory } = await import("../src/session.ts");
  appendHistory("first prompt");
  appendHistory("second prompt");
  appendHistory("second prompt"); // consecutive dupe is dropped
  expect(loadHistory()).toEqual(["first prompt", "second prompt"]);
  // history.json lives in the per-project slug dir under sessions/
  const sessions = join(dir, "sessions");
  const slugDir = join(sessions, readdirSync(sessions)[0]!);
  expect(JSON.parse(readFileSync(join(slugDir, "history.json"), "utf8"))).toHaveLength(2);
  expect(noTmpLeft(slugDir)).toBe(true);
});

test("saveAccounts writes valid JSON atomically (no .tmp left behind)", async () => {
  const { saveAccounts, loadAccounts } = await import("../src/accounts/store.ts");
  saveAccounts({ version: 1, accounts: [], defaults: {} });
  expect(loadAccounts()).toEqual({ version: 1, accounts: [], defaults: {} });
  expect(noTmpLeft(dir)).toBe(true);
});

test("secret file store (writeEnc) round-trips atomically", async () => {
  process.env.GEARBOX_SECRET_STORE = "file"; // force the encrypted-file path
  const { setSecret, getSecret } = await import("../src/accounts/store.ts");
  await setSecret("acct-1/api-key", "sk-test-123");
  expect(await getSecret("acct-1/api-key")).toBe("sk-test-123");
  expect(JSON.parse(readFileSync(join(dir, "credentials.enc"), "utf8"))).toBeTruthy();
  expect(noTmpLeft(dir)).toBe(true);
  delete process.env.GEARBOX_SECRET_STORE;
});

// ── windowType boundaries (Codex window_minutes → window label) ──────────────
test("windowType: 300 min is five_hour; 1440 (daily) and 10080 (weekly) are not", async () => {
  const { windowType } = await import("../src/accounts/usage-probe.ts");
  expect(windowType(300, "primary")).toBe("five_hour");
  expect(windowType(8 * 60, "primary")).toBe("five_hour"); // inclusive boundary
  expect(windowType(1440, "primary")).toBe("seven_day");
  expect(windowType(10080, "secondary")).toBe("seven_day");
  // missing window_minutes → fall back by slot
  expect(windowType(undefined, "primary")).toBe("five_hour");
  expect(windowType(undefined, "secondary")).toBe("seven_day");
});

test("cleanup", () => {
  rmSync(dir, { recursive: true, force: true });
});
