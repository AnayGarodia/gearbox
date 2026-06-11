import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import type { Task } from "./selector.ts";

export type PreferenceSource = "confirmed";
export type PreferenceKind = NonNullable<Task["kind"]>;

export interface RoutingPreference {
  kind: PreferenceKind;
  modelId?: string;
  provider?: string;
  accountId?: string;
  count: number;
  source: PreferenceSource;
  repo?: string;
  updatedAt: number;
}

// A self-declared spend budget — the anchor that lets us ESTIMATE the remaining
// balance providers don't expose (estimate = budget − our tracked spend). Keyed
// by accountId or provider. "total" = a prepaid pot; "monthly" = a per-month cap.
export interface BudgetConfig {
  amountUSD: number;
  period: "total" | "monthly";
}

interface PreferenceFile {
  version: 1;
  byKind: Partial<Record<PreferenceKind, RoutingPreference>>;
  global?: GlobalPreference;
  budgets?: Record<string, BudgetConfig>; // key: accountId or provider
}

// A standing, task-independent routing bias the user sets explicitly. `prefer`
// is a hard filter (use only subscription seats, or only metered API, when that
// still leaves a bar-clearing candidate); `accountId`/`provider` pin routing to
// one account/provider when it can do the job. All optional.
export interface GlobalPreference {
  prefer?: "subscription" | "api";
  accountId?: string;
  provider?: string;
}

// The POLICY: the full set of standing routing rules, a superset of
// GlobalPreference. Persisted inside the same `global` slot of
// routing-preferences.json — version-1 files without these fields load
// unchanged (every field optional, absent = no rule).
export interface Policy extends GlobalPreference {
  avoidProviders?: string[]; // never route to these providers
  avoidModels?: string[]; // never route to these model ids
  accountOrder?: string[]; // account ids/slugs, earlier = preferred tiebreak
  useFirst?: string[]; // provider or accountId to drain first while its declared budget/balance lasts
}

// Structured ops for updatePolicy: add/remove for the avoid lists, whole-list
// set for the ordered ones, scalar for `prefer`, and budget routed through
// setBudget so the one budget write path stays single.
export interface PolicyOps {
  avoidProviders?: { add?: string[]; remove?: string[] };
  avoidModels?: { add?: string[]; remove?: string[] };
  accountOrder?: { set?: string[] };
  useFirst?: { set?: string[] };
  prefer?: "subscription" | "api" | null;
  budget?: { key: string; amountUSD: number | null; period?: "total" | "monthly" };
}

const home = () => process.env.GEARBOX_HOME || join(homedir(), ".gearbox");
const file = () => join(home(), "routing-preferences.json");

function empty(): PreferenceFile {
  return { version: 1, byKind: {} };
}

// 10s TTL read cache (same pattern as priors.ts): this file is read twice per
// routing decision (preferenceFor + globalPreference); any write refreshes it.
// Keyed by the resolved path so a GEARBOX_HOME change (tests) never serves
// another home's data.
let cache: { f: PreferenceFile; at: number; path: string } | null = null;
const TTL = 10_000;

function load(): PreferenceFile {
  try {
    const f = JSON.parse(readFileSync(file(), "utf8"));
    if (f?.byKind) return { version: 1, byKind: f.byKind, global: f.global, budgets: f.budgets };
  } catch {
    /* none yet */
  }
  return empty();
}

export function loadRoutingPreferences(): PreferenceFile {
  const now = Date.now();
  const path = file();
  if (!cache || cache.path !== path || now - cache.at > TTL) cache = { f: load(), at: now, path };
  return cache.f;
}

export function loadBudgets(): Record<string, BudgetConfig> {
  return loadRoutingPreferences().budgets ?? {};
}

/** The budget that applies to an account: its own first, else its provider's. */
export function budgetFor(accountId: string, provider?: string): BudgetConfig | undefined {
  const b = loadBudgets();
  return b[accountId] ?? (provider ? b[provider] : undefined);
}

/** Set/clear a budget for an account id or provider (pass null to clear). */
export function setBudget(key: string, budget: BudgetConfig | null): void {
  const prefs = loadRoutingPreferences();
  const budgets = { ...(prefs.budgets ?? {}) };
  if (budget) budgets[key] = budget;
  else delete budgets[key];
  prefs.budgets = budgets;
  save(prefs);
}

export function globalPreference(): GlobalPreference | undefined {
  return loadRoutingPreferences().global;
}

/** Set/merge the standing global routing preference. Pass {} to clear a field. */
export function setGlobalPreference(global: GlobalPreference | null): GlobalPreference | undefined {
  const prefs = loadRoutingPreferences();
  prefs.global = global ?? undefined;
  save(prefs);
  return prefs.global;
}

/** The merged current policy: the stored global preference plus the new fields. */
export function policy(): Policy {
  return { ...(loadRoutingPreferences().global ?? {}) };
}

// Apply add/remove ops to a string list, deduping and dropping the field
// entirely when it ends up empty (keeps the persisted file minimal and the
// back-compat shape clean).
function applyListOps(cur: string[] | undefined, ops?: { add?: string[]; remove?: string[] }): string[] | undefined {
  if (!ops) return cur;
  const set = new Set(cur ?? []);
  for (const v of ops.add ?? []) set.add(v);
  for (const v of ops.remove ?? []) set.delete(v);
  return set.size ? [...set] : undefined;
}

/** Apply structured policy ops and persist; returns the resulting policy. */
export function updatePolicy(ops: PolicyOps): Policy {
  const next: Policy = { ...(loadRoutingPreferences().global ?? {}) };
  next.avoidProviders = applyListOps(next.avoidProviders, ops.avoidProviders);
  next.avoidModels = applyListOps(next.avoidModels, ops.avoidModels);
  if (ops.accountOrder?.set) next.accountOrder = ops.accountOrder.set.length ? ops.accountOrder.set : undefined;
  if (ops.useFirst?.set) next.useFirst = ops.useFirst.set.length ? ops.useFirst.set : undefined;
  if (ops.prefer !== undefined) next.prefer = ops.prefer ?? undefined;
  // Budget rides the existing single write path (setBudget saves the file
  // itself); do it FIRST so our save below carries the budget too — both
  // writes go through the same cache, so order only matters for the cache.
  if (ops.budget) {
    const { key, amountUSD, period } = ops.budget;
    setBudget(key, amountUSD == null ? null : { amountUSD, period: period ?? "total" });
  }
  // An all-undefined policy clears the global slot entirely (back to the
  // pristine version-1 shape) rather than persisting an empty object.
  const hasAny = Object.values(next).some((v) => v !== undefined);
  const prefs = loadRoutingPreferences();
  prefs.global = hasAny ? next : undefined;
  save(prefs);
  return { ...next };
}

/**
 * The WHOLE standing policy as plain-English lines, each with its one-line
 * undo command — the user should never have to remember the schema to walk
 * a rule back.
 */
export function describePolicy(): string[] {
  const p = policy();
  const lines: string[] = [];
  if (p.prefer) lines.push(`preferring ${p.prefer === "subscription" ? "subscription seats" : "metered API"} · undo: /prefer clear`);
  if (p.provider) lines.push(`pinned to provider: ${p.provider} · undo: /prefer clear`);
  if (p.accountId) lines.push(`pinned to account: ${p.accountId} · undo: /prefer clear`);
  if (p.avoidProviders?.length) lines.push(`avoiding providers: ${p.avoidProviders.join(", ")} · undo: /prefer allow ${p.avoidProviders.join(" ")}`);
  if (p.avoidModels?.length) lines.push(`avoiding models: ${p.avoidModels.join(", ")} · undo: /prefer allow ${p.avoidModels.join(" ")}`);
  if (p.accountOrder?.length) lines.push(`account order: ${p.accountOrder.join(" > ")} · undo: /prefer account order clear`);
  if (p.useFirst?.length) lines.push(`draining first: ${p.useFirst.join(", ")} (while declared budget lasts) · undo: /prefer use first clear`);
  const budgets = loadBudgets();
  for (const [key, b] of Object.entries(budgets)) {
    lines.push(`budget for ${key}: $${b.amountUSD}${b.period === "monthly" ? "/month" : " total"} · undo: /budget ${key} clear`);
  }
  if (!lines.length) return ["no standing preferences — /prefer <say it in plain words>"];
  return lines;
}

function save(prefs: PreferenceFile): void {
  try {
    mkdirSync(dirname(file()), { recursive: true });
    writeFileSync(file(), JSON.stringify(prefs, null, 2), { mode: 0o600 });
  } catch {
    /* best-effort */
  }
  cache = { f: prefs, at: Date.now(), path: file() };
}

export function preferenceFor(kind: PreferenceKind): RoutingPreference | undefined {
  return loadRoutingPreferences().byKind[kind];
}

export function confirmRoutingPreference(pref: Omit<RoutingPreference, "count" | "source" | "updatedAt">): RoutingPreference {
  const prefs = loadRoutingPreferences();
  const prev = prefs.byKind[pref.kind];
  const next: RoutingPreference = {
    ...pref,
    count: (prev?.count ?? 0) + 1,
    source: "confirmed",
    updatedAt: Date.now(),
  };
  prefs.byKind[pref.kind] = next;
  save(prefs);
  return next;
}

