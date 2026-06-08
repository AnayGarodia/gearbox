// Persisted UI preferences (effort, notifications, inline vs fullscreen).
// Stored at ~/.gearbox/prefs.json (GEARBOX_HOME overrides the dir). All reads and
// writes are best-effort — a missing/corrupt file just yields defaults.
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

export interface Prefs {
  effort?: "fast" | "balanced" | "max";
  notify?: boolean; // desktop notification on long turns
  fullscreen?: boolean; // false = inline mode (native scrollback + select-to-copy)
  ghost?: string; // mascot skin name
  onboarded?: boolean; // first-run screen has been shown
  vim?: boolean; // vim keybindings in the composer
  pinnedModel?: string; // /model pin; absent or "auto" means routing; restored on next launch
  activeAccount?: string | null; // active subscription account id; restored on next launch
  statusPinned?: boolean; // /cost pins a persistent usage strip above the composer
  verify?: "auto" | "off"; // auto = run checks after edits and iterate to green; off = skip
  budgetCaps?: { session?: number; daily?: number; monthly?: number; total?: number }; // hard spend ceilings (/cap)
}

function file(): string {
  const dir = process.env.GEARBOX_HOME || join(homedir(), ".gearbox");
  return join(dir, "prefs.json");
}

export function loadPrefs(): Prefs {
  try {
    return JSON.parse(readFileSync(file(), "utf8")) as Prefs;
  } catch {
    return {};
  }
}

export function savePrefs(p: Prefs): void {
  try {
    mkdirSync(dirname(file()), { recursive: true });
    writeFileSync(file(), JSON.stringify(p, null, 2));
  } catch {
    /* best-effort */
  }
}

/** Merge + persist a partial update; returns the new prefs. */
export function updatePrefs(patch: Partial<Prefs>): Prefs {
  const next = { ...loadPrefs(), ...patch };
  savePrefs(next);
  return next;
}
