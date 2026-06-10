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

