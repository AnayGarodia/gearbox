// The provider truth matrix: model picking + row formatting (live calls are
// exercised by `gearbox doctor live` itself, not in tests).
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pickTestModel, formatDoctorRows, type DoctorRow } from "../src/accounts/doctor.ts";
import type { Account } from "../src/accounts/types.ts";

const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ["ANTHROPIC_API_KEY", "GEARBOX_HOME"]) saved[k] = process.env[k];
  process.env.GEARBOX_HOME = mkdtempSync(join(tmpdir(), "gearbox-doctor-"));
  process.env.ANTHROPIC_API_KEY = "k";
});
afterEach(() => {
  for (const k of ["ANTHROPIC_API_KEY", "GEARBOX_HOME"]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
});

const acct = (over: Partial<Account>): Account => ({
  id: "a1", label: "A", provider: "anthropic", exec: "in-loop",
  auth: { kind: "api-key", ref: "a1:api-key" }, enabled: true, addedAt: 0, ...over,
} as Account);

test("pickTestModel prefers the account's own discovered ids when they match the registry", () => {
  const m = pickTestModel(acct({ models: ["claude-haiku-4-5"] }));
  expect(m?.sdkId).toBe("claude-haiku-4-5");
});

test("pickTestModel synthesizes a callable spec for discovered-only ids (gateways, Azure deployments)", () => {
  const m = pickTestModel(acct({ provider: "azure", models: ["my-gpt4o-deployment"] }));
  expect(m?.sdkId).toBe("my-gpt4o-deployment");
  expect(m?.provider).toBe("azure");
  expect(m?.contextWindow).toBeGreaterThan(0);
});

test("pickTestModel falls back to the cheapest registry model (a health probe, not a quality test)", () => {
  const m = pickTestModel(acct({}));
  expect(m).toBeTruthy();
  expect(m!.provider).toBe("anthropic");
  expect(m!.sdkId).toContain("haiku"); // cheapest anthropic model
});

test("formatDoctorRows: ok rows show latency, failing rows carry the fix", () => {
  const rows: DoctorRow[] = [
    { account: "claude-work", provider: "anthropic", model: "Haiku 4.5", ok: true, ms: 412 },
    { account: "openai-1", provider: "openai", model: "gpt-5.5-mini", ok: false, state: "invalid", message: "401 invalid api key", fix: "replace the key: /account add openai <key>" },
  ];
  const out = formatDoctorRows(rows);
  expect(out).toContain("✓ ok · 412ms");
  expect(out).toContain("✗ invalid · 401 invalid api key");
  expect(out).toContain("fix: replace the key");
  expect(out).toContain("1/2 working");
});
