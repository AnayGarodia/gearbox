import { test, expect, beforeEach } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadBudgets,
  budgetFor,
  setBudget,
  globalPreference,
  setGlobalPreference,
  preferenceFor,
  confirmRoutingPreference,
} from '../src/model/preferences.ts';

// Point GEARBOX_HOME at a fresh temp dir before every test so each test starts
// with a completely empty preferences file (the module reads the file on every
// call, so changing the env var is sufficient isolation without re-importing).
beforeEach(() => {
  process.env.GEARBOX_HOME = mkdtempSync(join(tmpdir(), 'gearbox-prefs-test-'));
});

// ── 1. loadBudgets returns {} when no file exists ──────────────────────────
test('loadBudgets() returns {} when no file exists', () => {
  expect(loadBudgets()).toEqual({});
});

// ── 2. budgetFor returns undefined when no budgets set ────────────────────
test('budgetFor returns undefined when no budgets have been set', () => {
  expect(budgetFor('any-account', 'any-provider')).toBeUndefined();
});

// ── 3. setBudget then budgetFor returns the stored budget ─────────────────
test('setBudget stores a budget and budgetFor retrieves it by accountId', () => {
  setBudget('acct1', { amountUSD: 50, period: 'total' });
  expect(budgetFor('acct1')).toEqual({ amountUSD: 50, period: 'total' });
});

// ── 4. Account-level budget takes priority over provider-level ────────────
test('budgetFor returns the account-level budget when both account and provider budgets exist', () => {
  setBudget('acct1', { amountUSD: 100, period: 'monthly' });
  setBudget('openai', { amountUSD: 999, period: 'total' });
  expect(budgetFor('acct1', 'openai')).toEqual({ amountUSD: 100, period: 'monthly' });
});

// ── 5. Falls back to provider budget when account has none ────────────────
test('budgetFor falls back to the provider budget when accountId has no budget', () => {
  setBudget('openai', { amountUSD: 200, period: 'monthly' });
  expect(budgetFor('unknown-acct', 'openai')).toEqual({ amountUSD: 200, period: 'monthly' });
});

// ── 6. setBudget(key, null) removes the budget ────────────────────────────
test('setBudget with null removes the budget; budgetFor returns undefined afterwards', () => {
  setBudget('acct1', { amountUSD: 75, period: 'total' });
  expect(budgetFor('acct1')).toBeDefined(); // sanity-check it was set
  setBudget('acct1', null);
  expect(budgetFor('acct1')).toBeUndefined();
});

// ── 7. globalPreference returns undefined when no file exists ─────────────
test('globalPreference() returns undefined when no file exists', () => {
  expect(globalPreference()).toBeUndefined();
});

// ── 8. setGlobalPreference persists and globalPreference reads it back ────
test('setGlobalPreference stores the preference and globalPreference returns it', () => {
  setGlobalPreference({ prefer: 'subscription' });
  expect(globalPreference()).toEqual({ prefer: 'subscription' });
});

// ── 9. setGlobalPreference(null) clears the stored preference ─────────────
test('setGlobalPreference(null) clears the global preference', () => {
  setGlobalPreference({ prefer: 'api' });
  expect(globalPreference()).toBeDefined(); // sanity-check it was set
  setGlobalPreference(null);
  expect(globalPreference()).toBeUndefined();
});

// ── 10. preferenceFor returns undefined when nothing set ──────────────────
test('preferenceFor returns undefined when no preference has been confirmed', () => {
  expect(preferenceFor('code')).toBeUndefined();
});

// ── 11. confirmRoutingPreference returns count=1 and source='confirmed' ───
test('confirmRoutingPreference returns a preference with count=1 and source confirmed', () => {
  const result = confirmRoutingPreference({ kind: 'code', modelId: 'claude-sonnet-4-6' });
  expect(result.count).toBe(1);
  expect(result.source).toBe('confirmed');
  expect(result.kind).toBe('code');
  expect(result.modelId).toBe('claude-sonnet-4-6');
  expect(typeof result.updatedAt).toBe('number');
});

// ── 12. Repeated confirmRoutingPreference increments count ────────────────
test('calling confirmRoutingPreference again for the same kind increments count to 2', () => {
  confirmRoutingPreference({ kind: 'code', modelId: 'claude-sonnet-4-6' });
  const second = confirmRoutingPreference({ kind: 'code', modelId: 'claude-sonnet-4-6' });
  expect(second.count).toBe(2);
});

// ── 13. preferenceFor returns the saved preference after confirming ────────
test('preferenceFor returns the saved preference after confirmRoutingPreference', () => {
  confirmRoutingPreference({ kind: 'code', modelId: 'claude-sonnet-4-6' });
  const pref = preferenceFor('code');
  expect(pref).toBeDefined();
  expect(pref!.kind).toBe('code');
  expect(pref!.modelId).toBe('claude-sonnet-4-6');
  expect(pref!.count).toBe(1);
  expect(pref!.source).toBe('confirmed');
});

// ── 14. Different kinds are stored independently ──────────────────────────
test('confirmRoutingPreference for summarize does not affect the code preference', () => {
  confirmRoutingPreference({ kind: 'code', modelId: 'claude-sonnet-4-6' });
  confirmRoutingPreference({ kind: 'summarize', modelId: 'claude-haiku-4-5' });

  const codePref = preferenceFor('code');
  const summarizePref = preferenceFor('summarize');

  expect(codePref).toBeDefined();
  expect(codePref!.modelId).toBe('claude-sonnet-4-6');
  expect(codePref!.count).toBe(1);

  expect(summarizePref).toBeDefined();
  expect(summarizePref!.modelId).toBe('claude-haiku-4-5');
  expect(summarizePref!.count).toBe(1);
});
