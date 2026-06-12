// Symbol navigation seam: "where is this symbol defined / who references it?"
// Built on the same per-(server, root) client cache as diagnostics. Same hard
// rule: never throw — every failure degrades to { locations: [], note }.
//
// The agent-facing API is symbol-by-NAME, not by position: the model knows
// names, not columns. We locate the symbol's occurrence in the source (at the
// given line when provided, else the first definition-looking occurrence, else
// the first occurrence) and ask the server at that position.
import { readFileSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import { acquireClient, type CheckOptions } from "./diagnostics.ts";

export interface SymbolLocation {
  path: string;
  line: number;
  col: number;
  /** The source line at the location, trimmed — context for the model. */
  text: string;
}

/**
 * Find the 1-based (line, col) of `symbol` in `content` to anchor the LSP
 * request. Preference order: occurrence on `nearLine` → an occurrence preceded
 * by a definition keyword → the first whole-word occurrence. Pure; exported
 * for tests.
 */
export function findSymbolPosition(content: string, symbol: string, nearLine?: number): { line: number; col: number } | null {
  if (!symbol) return null;
  const esc = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const word = new RegExp(`(?<![A-Za-z0-9_$])${esc}(?![A-Za-z0-9_$])`);
  const def = new RegExp(`\\b(?:function|class|interface|type|const|let|var|enum|def|fn|func|struct|trait|impl)\\s+${esc}(?![A-Za-z0-9_$])`);
  const lines = content.split("\n");
  const hit = (i: number): { line: number; col: number } | null => {
    const m = word.exec(lines[i]!);
    return m ? { line: i + 1, col: m.index + 1 } : null;
  };
  if (nearLine && nearLine >= 1 && nearLine <= lines.length) {
    const h = hit(nearLine - 1);
    if (h) return h;
  }
  for (let i = 0; i < lines.length; i++) if (def.test(lines[i]!)) return hit(i)!;
  for (let i = 0; i < lines.length; i++) {
    const h = hit(i);
    if (h) return h;
  }
  return null;
}

export async function symbolLocations(
  kind: "definition" | "references",
  absPath: string,
  symbol: string,
  cwd: string,
  opts: CheckOptions & { nearLine?: number } = {},
): Promise<{ locations: SymbolLocation[]; note?: string }> {
  try {
    let content: string;
    try {
      content = readFileSync(absPath, "utf8");
    } catch (e) {
      return { locations: [], note: `cannot read ${absPath}: ${e instanceof Error ? e.message : String(e)}` };
    }
    const pos = findSymbolPosition(content, symbol, opts.nearLine);
    if (!pos) return { locations: [], note: `"${symbol}" does not appear in ${absPath}` };

    const { client, note } = await acquireClient(absPath, content, cwd, opts);
    if (!client) return { locations: [], note };

    const raw = await client.locations(kind, absPath, pos.line, pos.col, opts.timeoutMs);
    const locations = raw.map((l) => ({ ...l, text: lineAt(l.path, l.line) }));
    return { locations, note: client.note };
  } catch (e) {
    return { locations: [], note: `lsp ${kind} failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

function lineAt(path: string, line: number): string {
  try {
    return (readFileSync(path, "utf8").split("\n")[line - 1] ?? "").trim().slice(0, 200);
  } catch {
    return "";
  }
}

/**
 * The compact block the model sees:
 *   src/model/router.ts:42:17  export function rankFiles(query: string, …
 * Paths relativized against cwd when under it.
 */
export function formatLocations(locs: SymbolLocation[], maxLines = 30, cwd = process.cwd()): string {
  if (locs.length === 0) return "";
  const lines = locs.slice(0, Math.max(1, maxLines)).map((l) => {
    let p = l.path;
    if (isAbsolute(p)) {
      const rel = relative(cwd, p);
      if (rel && !rel.startsWith("..") && !isAbsolute(rel)) p = rel;
    }
    return l.text ? `${p}:${l.line}:${l.col}  ${l.text}` : `${p}:${l.line}:${l.col}`;
  });
  if (locs.length > maxLines) lines.push(`… and ${locs.length - maxLines} more`);
  return lines.join("\n");
}
