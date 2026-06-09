// Clickable links (OSC 8) without breaking Ink's width math: the escape
// sequences are injected POST-LAYOUT via Ink's <Transform>, never as span text
// (raw ANSI in span text would corrupt wrapping — the project's oldest rule).
// Terminals that don't support OSC 8 render the plain text unchanged.
import { resolve } from "node:path";
import { loadPrefs } from "./prefs.ts";

/** Wrap already-rendered output in an OSC 8 hyperlink (Transform callback). */
export function osc8(url: string): (out: string) => string {
  return (out) => `\x1b]8;;${url}\x1b\\${out}\x1b]8;;\x1b\\`;
}

const EDITOR_SCHEMES: Record<string, (abs: string, line?: number) => string> = {
  vscode: (abs, line) => `vscode://file${abs}${line ? `:${line}` : ""}`,
  cursor: (abs, line) => `cursor://file${abs}${line ? `:${line}` : ""}`,
  windsurf: (abs, line) => `windsurf://file${abs}${line ? `:${line}` : ""}`,
  zed: (abs, line) => `zed://file${abs}${line ? `:${line}` : ""}`,
};

export function editorNames(): string[] {
  return [...Object.keys(EDITOR_SCHEMES), "off"];
}

let cachedEditor: string | undefined;

/** The configured editor scheme name ("vscode" default; "off" disables). */
export function editorPref(): string {
  if (cachedEditor === undefined) cachedEditor = loadPrefs().editor ?? "vscode";
  return cachedEditor;
}

export function setEditorPref(name: string): void {
  cachedEditor = name;
}

/** A clickable editor URL for a workspace path, or undefined when disabled /
 *  the path doesn't look like a real file reference. */
export function editorUrl(path: string, line?: number, cwd = process.cwd()): string | undefined {
  const editor = editorPref();
  const scheme = EDITOR_SCHEMES[editor];
  if (!scheme) return undefined; // "off" or unknown
  const clean = path.trim();
  if (!clean || /\s/.test(clean) || clean.startsWith("-")) return undefined;
  return scheme(resolve(cwd, clean), line);
}

/** Looks like a workspace file path a tool head would show (not a command). */
export function pathish(s: string): boolean {
  return /^[\w@./-]+\.[A-Za-z0-9]{1,8}(?::\d+)?$/.test(s.trim());
}
