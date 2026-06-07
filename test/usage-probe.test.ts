import { test, expect } from "bun:test";
import { parseClaudeRateLimits, parseCodexRateLimits, findRateLimits } from "../src/accounts/usage-probe.ts";

// ── Claude statusLine rate_limits (used_percentage 0–100, resets_at unix sec) ──
test("parses both Claude windows, percentage → 0..1 utilization", () => {
  const snaps = parseClaudeRateLimits({
    five_hour: { used_percentage: 24, resets_at: 1780834200 },
    seven_day: { used_percentage: 81, resets_at: 1780718400 },
  });
  expect(snaps).toEqual([
    { type: "five_hour", utilization: 0.24, resetsAt: 1780834200 },
    { type: "seven_day", utilization: 0.81, resetsAt: 1780718400 },
  ]);
});

test("Claude: a single reported window is fine (Pro often omits seven_day)", () => {
  const snaps = parseClaudeRateLimits({ five_hour: { used_percentage: 23, resets_at: 1 } });
  expect(snaps).toHaveLength(1);
  expect(snaps[0]!.type).toBe("five_hour");
  expect(snaps[0]!.utilization).toBeCloseTo(0.23, 5);
});

test("Claude: empty / malformed → no snapshots (caller falls back)", () => {
  expect(parseClaudeRateLimits(null)).toEqual([]);
  expect(parseClaudeRateLimits({})).toEqual([]);
  expect(parseClaudeRateLimits({ five_hour: {} })).toEqual([]);
});

test("Claude: utilization is clamped to [0,1]", () => {
  const snaps = parseClaudeRateLimits({ five_hour: { used_percentage: 130, resets_at: 1 } });
  expect(snaps[0]!.utilization).toBe(1);
});

// ── Codex rollout rate_limits (used_percent, window_minutes, resets_at) ────────
test("maps Codex primary→five_hour, secondary→seven_day by window_minutes", () => {
  const snaps = parseCodexRateLimits(
    {
      primary: { used_percent: 53, window_minutes: 300, resets_at: 1780746696 },
      secondary: { used_percent: 89, window_minutes: 10080, resets_at: 1781170453 },
    },
    9999,
  );
  expect(snaps).toEqual([
    { type: "five_hour", utilization: 0.53, resetsAt: 1780746696, at: 9999 },
    { type: "seven_day", utilization: 0.89, resetsAt: 1781170453, at: 9999 },
  ]);
});

test("Codex: falls back to slot order when window_minutes missing", () => {
  const snaps = parseCodexRateLimits({ primary: { used_percent: 10 }, secondary: { used_percent: 20 } });
  expect(snaps.map((s) => s.type)).toEqual(["five_hour", "seven_day"]);
});

test("Codex: a 0% window still records (within limits, not absent)", () => {
  const snaps = parseCodexRateLimits({ primary: { used_percent: 0, window_minutes: 300, resets_at: 5 } });
  expect(snaps).toEqual([{ type: "five_hour", utilization: 0, resetsAt: 5, at: undefined }]);
});

// ── findRateLimits: pull rate_limits out of a nested rollout event ─────────────
test("finds rate_limits nested inside a Codex token_count event", () => {
  const event = {
    type: "event_msg",
    payload: { type: "token_count", rate_limits: { primary: { used_percent: 1, window_minutes: 300 } } },
  };
  const rl = findRateLimits(event);
  expect(rl?.primary?.used_percent).toBe(1);
});

test("findRateLimits returns null when there is no usable window", () => {
  expect(findRateLimits({ a: { b: { c: 1 } } })).toBeNull();
  expect(findRateLimits({ rate_limits: null })).toBeNull();
});
