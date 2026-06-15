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
  policy,
  updatePolicy,
  describePolicy,
} from '../src/model/preferences.ts';
import { writeFileSync, mkdirSync } from 'node:fs';

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

// ── POLICY ─────────────────────────────────────────────────────────────────

// ── 15. policy() is empty when nothing is set ──────────────────────────────
test('policy() returns an empty object when no file exists', () => {
  expect(policy()).toEqual({});
});

// ── 16. updatePolicy round-trips through the file ──────────────────────────
test('updatePolicy persists and policy() reads it back (round-trip)', () => {
  updatePolicy({
    avoidProviders: { add: ['deepseek', 'moonshot'] },
    avoidModels: { add: ['gpt-4o-mini'] },
    accountOrder: { set: ['claude-work', 'openai-personal'] },
    useFirst: { set: ['deepseek'] },
    prefer: 'subscription',
  });
  const p = policy();
  expect(p.avoidProviders).toEqual(['deepseek', 'moonshot']);
  expect(p.avoidModels).toEqual(['gpt-4o-mini']);
  expect(p.accountOrder).toEqual(['claude-work', 'openai-personal']);
  expect(p.useFirst).toEqual(['deepseek']);
  expect(p.prefer).toBe('subscription');
});

// ── 17. op application: add dedupes, remove deletes, empty list drops field ─
test('updatePolicy applies add/remove ops with dedupe and drops empty lists', () => {
  updatePolicy({ avoidProviders: { add: ['deepseek', 'deepseek', 'moonshot'] } });
  expect(policy().avoidProviders).toEqual(['deepseek', 'moonshot']);
  updatePolicy({ avoidProviders: { remove: ['deepseek'] } });
  expect(policy().avoidProviders).toEqual(['moonshot']);
  updatePolicy({ avoidProviders: { remove: ['moonshot'] } });
  expect(policy().avoidProviders).toBeUndefined();
});

// ── 18. prefer: null clears; set ops with [] clear their field ──────────────
test('updatePolicy clears prefer with null and ordered lists with empty set', () => {
  updatePolicy({ prefer: 'api', accountOrder: { set: ['a', 'b'] } });
  updatePolicy({ prefer: null, accountOrder: { set: [] } });
  const p = policy();
  expect(p.prefer).toBeUndefined();
  expect(p.accountOrder).toBeUndefined();
});

// ── 19. budget op routes through setBudget ──────────────────────────────────
test('updatePolicy budget op stores via setBudget and clears with null amount', () => {
  updatePolicy({ budget: { key: 'deepseek', amountUSD: 20, period: 'monthly' } });
  expect(budgetFor('any', 'deepseek')).toEqual({ amountUSD: 20, period: 'monthly' });
  updatePolicy({ budget: { key: 'deepseek', amountUSD: null } });
  expect(budgetFor('any', 'deepseek')).toBeUndefined();
});

// ── 20. policy preserves the existing GlobalPreference fields (merge) ───────
test('updatePolicy merges over an existing global preference instead of replacing it', () => {
  setGlobalPreference({ prefer: 'subscription', provider: 'anthropic' });
  updatePolicy({ avoidModels: { add: ['gpt-5-nano'] } });
  const p = policy();
  expect(p.prefer).toBe('subscription');
  expect(p.provider).toBe('anthropic');
  expect(p.avoidModels).toEqual(['gpt-5-nano']);
});

// ── 21. back-compat: a version-1 file without the new fields still loads ────
test('a pre-policy version-1 file loads cleanly and policy() shows only old fields', () => {
  const home = process.env.GEARBOX_HOME!;
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, 'routing-preferences.json'),
    JSON.stringify({
      version: 1,
      byKind: { code: { kind: 'code', modelId: 'm', count: 3, source: 'confirmed', updatedAt: 1 } },
      global: { prefer: 'api' },
      budgets: { openai: { amountUSD: 10, period: 'total' } },
    }),
  );
  expect(preferenceFor('code')!.count).toBe(3);
  expect(policy()).toEqual({ prefer: 'api' });
  expect(budgetFor('x', 'openai')).toEqual({ amountUSD: 10, period: 'total' });
  // and writing a policy on top keeps the old data intact
  updatePolicy({ avoidProviders: { add: ['xai'] } });
  expect(preferenceFor('code')!.count).toBe(3);
  expect(policy().prefer).toBe('api');
});

// ── 22. describePolicy: empty → the single hint line ────────────────────────
test('describePolicy returns the hint line when no policy is set', () => {
  expect(describePolicy()).toEqual(['no standing preferences — /prefer <say it in plain words>']);
});

// ── 23. describePolicy: each rule is a plain-English line with an undo ──────
test('describePolicy renders every rule with its undo command', () => {
  updatePolicy({
    prefer: 'subscription',
    avoidProviders: { add: ['deepseek', 'moonshot'] },
    avoidModels: { add: ['gpt-4o-mini'] },
    accountOrder: { set: ['claude-work', 'openai-personal'] },
    useFirst: { set: ['deepseek'] },
    budget: { key: 'deepseek', amountUSD: 20, period: 'monthly' },
  });
  const lines = describePolicy();
  expect(lines).toContain('preferring subscription seats · undo: /prefer clear');
  expect(lines).toContain('avoiding providers: deepseek, moonshot · undo: /prefer allow deepseek moonshot');
  expect(lines).toContain('avoiding models: gpt-4o-mini · undo: /prefer allow gpt-4o-mini');
  expect(lines).toContain('account order: claude-work > openai-personal · undo: /prefer account order clear');
  expect(lines).toContain('draining first: deepseek (while declared budget lasts) · undo: /prefer use first clear');
  expect(lines).toContain('budget for deepseek: $20/month · undo: /budget deepseek clear');
});

test('pinAccount round-trips through updatePolicy and clears with null', () => {
  expect(policy().pinAccount).toBeUndefined();
  updatePolicy({ pinAccount: 'azure-foundry-aztea' });
  expect(policy().pinAccount).toBe('azure-foundry-aztea');
  // unrelated ops don't disturb the pin
  updatePolicy({ prefer: 'api' });
  expect(policy().pinAccount).toBe('azure-foundry-aztea');
  updatePolicy({ pinAccount: null });
  expect(policy().pinAccount).toBeUndefined();
});
