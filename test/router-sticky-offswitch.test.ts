import { test, expect, afterEach, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoutingSelector } from "../src/model/router.ts";
import { subscriptionSeats } from "../src/providers.ts";
import { putAccount } from "../src/accounts/store.ts";
import { markExhausted, modelScopedKey, clearCooldowns, DEFAULT_COOLDOWN_MS } from "../src/model/cooldown.ts";
import type { Account } from "../src/accounts/types.ts";

// Isolate the store + a single Anthropic env key (the only in-loop API model)
// plus one claude-cli seat. The seat unions the catalog (haiku/sonnet/opus), so
// to construct a genuine seat→API flip we cool the seat's strong models, leaving
// only haiku (which sits below the `code` bar).
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ["ANTHROPIC_API_KEY", "GEARBOX_HOME"]) saved[k] = process.env[k];
  process.env.GEARBOX_HOME = mkdtempSync(join(tmpdir(), "gearbox-sticky-"));
  process.env.ANTHROPIC_API_KEY = "test-key";
  clearCooldowns();
});
afterEach(() => {
  clearCooldowns();
  for (const k of ["ANTHROPIC_API_KEY", "GEARBOX_HOME"]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
});

function claudeSeat(): Account {
  return {
    id: "claude-max", label: "Claude Max", provider: "claude-cli", exec: "cli",
    auth: { kind: "cli", binary: "claude" }, enabled: true, addedAt: 0,
  };
}

// Knock out every seat model except haiku so a hard `code` task has no
// bar-clearing seat candidate — without stickiness it must fall over to API.
function coolStrongSeatModels() {
  for (const s of subscriptionSeats().filter((s) => s.account.id === "claude-max" && s.canonicalId !== "claude-haiku-4-5")) {
    markExhausted(modelScopedKey("claude-max", s.spec.id), DEFAULT_COOLDOWN_MS, "test");
  }
}

test("CONTROL: with no warm seat, a code turn flips to the API when only haiku is on the seat", () => {
  putAccount(claudeSeat());
  coolStrongSeatModels();
  const choice = new RoutingSelector().select({ prompt: "rewrite the parser", kind: "code" });
  expect(choice.backend?.kind).toBe("in-loop"); // haiku seat below the bar → metered API sonnet
});

test("STICKY SEAT: once a conversation is on the seat, a hard code turn stays on it (no flip to API)", () => {
  putAccount(claudeSeat());
  coolStrongSeatModels();
  const sel = new RoutingSelector();
  const t1 = sel.select({ prompt: "summarize this transcript", kind: "summarize" });
  expect(t1.backend?.kind).toBe("cli"); // landed on the free seat
  const t2 = sel.select({ prompt: "rewrite the parser", kind: "code" });
  expect(t2.backend?.kind).toBe("cli"); // STAYED on the seat — the flip-flop is gone
});

test("STICKY API: once on the API, a light turn does not jump onto the free seat", () => {
  putAccount(claudeSeat());
  const sel = new RoutingSelector();
  // Simulate the conversation already being on an API model (warm = in-loop).
  const choice = sel.select({
    prompt: "summarize this transcript", kind: "summarize",
    warm: { accountId: "env:anthropic", modelId: "claude-sonnet-4-6", sub: false },
  });
  expect(choice.backend?.kind).toBe("in-loop"); // seat excluded — boundary not crossed
});

test("CONTROL: with no warm, that same light turn does take the free seat", () => {
  putAccount(claudeSeat());
  expect(new RoutingSelector().select({ prompt: "summarize this transcript", kind: "summarize" }).backend?.kind).toBe("cli");
});

test("ESCALATION + stickiness agree: a failed-VERIFY climb stays on the free seat (no needless API hop)", () => {
  // The escalation floor already keeps the free seat as a candidate, and the
  // sticky carve-out (skip stickiness when escalate>0) lets that floor run rather
  // than pinning the exact warm model — both land on the seat, so a verify-fail
  // climb does NOT cross the CLI↔API boundary when the seat can still serve it.
  putAccount(claudeSeat());
  const sel = new RoutingSelector();
  sel.select({ prompt: "summarize this transcript", kind: "summarize" }); // warm = haiku seat
  const escalated = sel.select({ prompt: "rewrite the parser", kind: "code", escalate: 3 });
  expect(escalated.backend?.kind).toBe("cli");
});

test("OFF SWITCH: excludeSubscriptions drops seats from routing entirely", () => {
  putAccount(claudeSeat());
  // Without the flag a cheap task takes the free seat (control).
  expect(new RoutingSelector().select({ prompt: "summarize this transcript", kind: "summarize" }).backend?.kind).toBe("cli");
  // With it, auto-routing stays on metered API.
  const off = new RoutingSelector().select({ prompt: "summarize this transcript", kind: "summarize", excludeSubscriptions: true });
  expect(off.backend?.kind).toBe("in-loop");
});

test("FAILOVER: a warm seat that just got rate-limited hops to API, not re-pinned by stickiness", () => {
  // Mirrors the live hop-loop: a seat turn fails → markExhausted(account) → the
  // failover re-select runs with lastPick.sub still true. Stickiness must NOT
  // re-pin the cooled seat; the cooldown filter removes it and routing hops to API.
  putAccount(claudeSeat());
  const sel = new RoutingSelector();
  const t1 = sel.select({ prompt: "summarize this transcript", kind: "summarize" });
  expect(t1.backend?.kind).toBe("cli"); // warm = the seat
  // The account-scoped park the hop-loop applies on an exhausted seat.
  markExhausted("claude-max", DEFAULT_COOLDOWN_MS, "rate limit");
  const next = sel.select({ prompt: "rewrite the parser", kind: "code" });
  expect(next.backend?.kind).toBe("in-loop"); // hopped to metered API, no seat re-pin
});

test("OFF SWITCH: explain() also excludes seats so /why agrees with routing", () => {
  putAccount(claudeSeat());
  const card = new RoutingSelector().explain({ prompt: "summarize this transcript", kind: "summarize", excludeSubscriptions: true });
  expect(card.entries.every((e) => e.backend !== "seat")).toBe(true);
});
