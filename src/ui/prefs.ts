// Persisted UI preferences (effort, notifications, inline vs fullscreen).
// Stored at ~/.gearbox/prefs.json (GEARBOX_HOME overrides the dir). All reads and
// writes are best-effort — a missing/corrupt file just yields defaults.
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

export interface Prefs {
  effort?: "fast" | "balanced" | "max";
  notify?: boolean; // desktop notification on long turns
  fullscreen?: boolean; // false → inline mode (native scroll + select-to-copy)
  ghost?: string; // mascot skin
  onboarded?: boolean; // first-run screen shown
  vim?: boolean; // composer vim keybindings
  pinnedModel?: string; // /model <name> pin (absent/"auto" = routing); restored next launch
  activeAccount?: string | null; // active CLI subscription account id; restored next launch
  statusPinned?: boolean; // /cost toggles a persistent usage strip above the composer
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
