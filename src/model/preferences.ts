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

interface PreferenceFile {
  version: 1;
  byKind: Partial<Record<PreferenceKind, RoutingPreference>>;
}

const home = () => process.env.GEARBOX_HOME || join(homedir(), ".gearbox");
const file = () => join(home(), "routing-preferences.json");

function empty(): PreferenceFile {
  return { version: 1, byKind: {} };
}

export function loadRoutingPreferences(): PreferenceFile {
  try {
    const f = JSON.parse(readFileSync(file(), "utf8"));
    if (f?.byKind) return { version: 1, byKind: f.byKind };
  } catch {
    /* none yet */
  }
  return empty();
}

function save(prefs: PreferenceFile): void {
  try {
    mkdirSync(dirname(file()), { recursive: true });
    writeFileSync(file(), JSON.stringify(prefs, null, 2), { mode: 0o600 });
  } catch {
    /* best-effort */
  }
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

