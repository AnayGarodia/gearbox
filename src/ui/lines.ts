// The transcript as a flat list of styled lines. This is what makes a real
// fullscreen scroll region possible: we render only the slice of lines that fits
// the viewport, so the frame is NEVER taller than the screen (Ink's own
// flex/overflow clipping is unreliable and corrupts on tall content). Each Line
// is a list of Spans (text + Ink-native style) — never raw ANSI, which would
// break Ink's width math. Wrapping happens here, at a known width, so every Line
// is exactly one terminal row.
import { marked } from "marked";
import { color, themeEpoch } from "./theme.ts";
import { glyph } from "./theme.ts";
import { highlightLine } from "./highlight.ts";
import type { Item } from "./types.ts";
import { barCells } from "../accounts/usage.ts";
import { retryPhrase } from "./collapse.ts";
import { scorecardRows } from "../commands.ts";
import { PROSE_RE, proseTokenStyle } from "./prose.ts";
import { editorUrl, pathish } from "./links.ts";

import { limitColor } from "./severity.ts";
// Limit window value: a utilization bar when a percentage is known, else a status word.
const limitValueSpans = (l: { pct?: number; status?: "ok" | "warn" | "limited" }): Span[] => {
  if (typeof l.pct === "number") {
    const lim = barCells(l.pct / 100, 10);
    return [{ text: lim.fill, color: limitColor(l.pct) }, { text: lim.empty, color: color.faint }, { text: " " + l.pct + "%", color: limitColor(l.pct) }];
  }
  const c = l.status === "limited" ? color.err : l.status === "warn" ? color.warn : color.ok;
  return [{ text: l.status === "limited" ? "limited" : l.status === "warn" ? "near limit" : "ok", color: c }];
};
// Account health → semantic color. ok=ready, err=invalid/not-signed-in (can't be
// used), warn=expired/limited/duplicate (attention, not broken), faint=unknown.
// No accent here: a state is never "interactive", so it never wears the now-color.
const accountStateColor = (status: string) =>
  status === "active" || status === "signed in" || status === "ready" || status.startsWith("✓") ? color.ok :
  status === "not signed in" || status.startsWith("✗") ? color.err :
  status === "duplicate" || status.startsWith("⚠") || status.startsWith("⏳") ? color.warn :
  color.faint;

export type Span = { text: string; color?: string; bold?: boolean; italic?: boolean; dim?: boolean; bg?: string; link?: string };
export type Line = Span[];
export const BLANK: Line = [];

/** Truncate a list of spans to `width` columns total (no wrapping). */
export function clipSpans(spans: Span[], width: number): Line {
  const out: Line = [];
  let len = 0;
  for (const s of spans) {
    if (len >= width) break;
    const t = s.text.slice(0, width - len);
    if (t) out.push({ ...s, text: t });
    len += t.length;
  }
  return out;
}

function lineWidth(line: Line): number {
  return line.reduce((n, s) => n + s.text.length, 0);
}

function padBg(line: Line, width: number, bg: string): Line {
  const len = lineWidth(line);
  return len < width ? [...line, { text: " ".repeat(width - len), bg }] : line;
}

type Style = Omit<Span, "text">;

const looseCodeLineRe =
  /^(\s{2,}\S|from\s+|import\s+|class\s+|def\s+|async\s+def\s+|@\w|if\s+|elif\s+|else:|for\s+|while\s+|try:|except\s+|finally:|with\s+|return\s+|[A-Za-z_][\w.]*\s*=|[A-Za-z_][\w.]*\(|"""|'''|\/\/|#include\b|const\s+|let\s+|var\s+|function\s+|type\s+|interface\s+|export\s+|package\s+|func\s+)/;

function looksLikeLooseCode(text: string): boolean {
  const lines = text.split("\n").filter((l) => l.trim());
  if (lines.length < 2) return false;
  const hits = lines.filter((l) => looseCodeLineRe.test(l.trimStart() === l ? l.trim() : l)).length;
  if (lines.length === 2) return hits === 2;
  return hits / lines.length >= 0.55;
}

function guessCodeLang(text: string): string {
  if (/^\s*(from|import|def|class|@dataclass)\b/m.test(text)) return "python";
  if (/^\s*(const|let|var|function|type|interface|export|import)\b/m.test(text)) return "ts";
  if (/^\s*(package|func)\b/m.test(text)) return "go";
  return "";
}

function codeRow(line: string, lang: string): { sign: string; code: string; bg: string; fg: string; lang: string } {
  const isDiff = /^(diff|patch)$/i.test(lang);
  if ((isDiff || /^[+-]/.test(line)) && line.startsWith("+") && !line.startsWith("+++")) {
    return { sign: "+", code: line.slice(1), bg: color.diffAddBg, fg: color.ok, lang: "" };
  }
  if ((isDiff || /^[+-]/.test(line)) && line.startsWith("-") && !line.startsWith("---")) {
    return { sign: "−", code: line.slice(1), bg: color.diffDelBg, fg: color.err, lang: "" };
  }
  return { sign: "", code: line, bg: color.codeBg, fg: color.faint, lang };
}

function codeBlockLines(code: string, lang: string, width: number): Line[] {
  const lines = code.replace(/\n$/, "").split("\n");
  const lineNoWidth = Math.max(2, String(lines.length).length);
  const blockWidth = Math.max(
    24,
    Math.min(
      width,
      Math.max(40, ...lines.map((l) => lineNoWidth + 3 + l.length), lang ? lang.length + 2 : 0),
    ),
  );
  const out: Line[] = [];
  if (lang) {
    out.push(padBg([{ text: ` ${lang} `, color: color.accentDim, bold: true, bg: color.codeBg }], blockWidth, color.codeBg));
  }
  for (let i = 0; i < lines.length; i++) {
    const row = codeRow(lines[i]!, lang);
    const prefix = `${row.sign || " "} ${String(i + 1).padStart(lineNoWidth)} │ `;
    const spans: Span[] = [
      { text: prefix, color: row.sign ? row.fg : color.faint, bold: Boolean(row.sign), bg: row.bg },
      ...(highlightLine(row.code, row.lang) as Span[]).map((s) => ({ ...s, bg: row.bg })),
    ];
    out.push(padBg(clipSpans(spans, blockWidth), blockWidth, row.bg));
  }
  return out;
}

// Prose highlighting: rich but precise. Tokens and styles live in prose.ts so this
// and the inline path (Markdown.tsx) always agree. Each match is anchored so
// ordinary English stays plain.
function proseSpans(text: string, base: Style = { color: color.text }): Span[] {
  const out: Span[] = [];
  let last = 0;
  for (const m of text.matchAll(PROSE_RE)) {
    const idx = m.index ?? 0;
    const raw = m[0]!;
    const leading = raw.match(/^\s+/)?.[0] ?? "";
    const token = raw.slice(leading.length);
    if (idx > last) out.push({ text: text.slice(last, idx), ...base });
    if (leading) out.push({ text: leading, ...base });
    out.push({ text: token, ...proseTokenStyle(token) });
    last = idx + raw.length;
  }
  if (last < text.length) out.push({ text: text.slice(last), ...base });
  return out.length ? out : [{ text, ...base }];
}

function noticeSpans(text: string): Span[] {
  const out: Span[] = [];
  const re = /(https?:\/\/[^\s)\]]+|\/[a-z][\w-]*(?:\s+[^\s]+)?|\b(?:Claude|ChatGPT|Anthropic|OpenAI|OpenRouter|subscription|API key|active|current|switch|add|remove|use)\b|\b\d+\.\b|\b\/account\s+\d+\b|`[^`]+`)/gi;
  let last = 0;
  for (const m of text.matchAll(re)) {
    const idx = m.index ?? 0;
    const token = m[0]!;
    if (idx > last) out.push({ text: text.slice(last, idx), color: color.dim });
    const low = token.toLowerCase();
    if (/^https?:\/\//i.test(token)) {
      out.push({ text: token, color: color.path, link: token });
      last = idx + token.length;
      continue;
    }
    const style =
      token.startsWith("/") || low.startsWith("/account") ? { color: color.accent, bold: true, bg: color.accentBg } :
      token.startsWith("`") ? { color: color.path, bg: color.codeBg } :
      /^\d+\.$/.test(token) ? { color: color.accentDim, bold: true } :
      low === "subscription" || low === "api key" ? { color: color.ok, bold: true } :
      low === "active" || low === "current" ? { color: color.user, bold: true } :
      low === "switch" || low === "add" || low === "remove" || low === "use" ? { color: color.accentDim, bold: true } :
      { color: color.text, bold: true };
    out.push({ text: token, ...style });
    last = idx + token.length;
  }
  if (last < text.length) out.push({ text: text.slice(last), color: color.dim });
  return out.length ? out : [{ text, color: color.dim }];
}

// ── The telemetry margin (Broadsheet) ─────────────────────────────────────────
// The page has two channels: a prose column and a right-aligned MARGIN column of
// figures (model, $, duration, ±lines). Narrative left, truth right. Below the
// threshold the margin folds inline (` · fig · fig`) — same data, narrow form.
export const MARGIN_W = 16;
export const marginWidth = (width: number): number => (width >= 88 ? MARGIN_W : 0);

/** One line: body clipped to the prose column, figures right-aligned in the
 *  margin column (or folded inline when the page is narrow). ≤width always. */
export function marginLine(body: Span[], figures: Span[], width: number): Line {
  const m = marginWidth(width);
  if (!figures.length) return clipSpans(body, width);
  if (m === 0) {
    const folded: Span[] = [...body];
    figures.forEach((f, i) => {
      folded.push({ text: i === 0 ? "  · " : " · ", color: color.faint });
      folded.push(f);
    });
    return clipSpans(folded, width);
  }
  const bodyW = width - m;
  const clipped = clipSpans(body, bodyW);
  const used = lineWidth(clipped);
  const figs: Span[] = [];
  figures.forEach((f, i) => {
    if (i > 0) figs.push({ text: " · ", color: color.faint });
    figs.push(f);
  });
  const figLine = clipSpans(figs, m);
  const pad = Math.max(0, bodyW - used + (m - lineWidth(figLine)));
  return [...clipped, { text: " ".repeat(pad) }, ...figLine];
}

/** Word-wrap a run of styled spans to `width`, preserving each span's style. */
export function wrapSpans(spans: Span[], width: number): Line[] {
  if (width < 1) width = 1;
  const lines: Line[] = [];
  let line: Span[] = [];
  let len = 0;
  const pushWord = (text: string, s: Style) => {
    let w = text;
    while (w.length > width) {
      // hard-break a word longer than the line
      if (len > 0) {
        lines.push(line);
        line = [];
        len = 0;
      }
      lines.push([{ text: w.slice(0, width), ...s }]);
      w = w.slice(width);
    }
    if (len + w.length > width && len > 0) {
      lines.push(line);
      line = [];
      len = 0;
    }
    line.push({ text: w, ...s });
    len += w.length;
  };
  for (const sp of spans) {
    // split into words + whitespace, carrying style
    const parts = sp.text.split(/(\s+)/);
    for (const p of parts) {
      if (p === "") continue;
      const s: Style = { color: sp.color, bold: sp.bold, italic: sp.italic, dim: sp.dim, bg: sp.bg };
      if (/^\s+$/.test(p)) {
        // collapse whitespace to a single space; drop at line start/wrap
        if (len === 0) continue;
        if (len + 1 > width) {
          lines.push(line);
          line = [];
          len = 0;
          continue;
        }
        line.push({ text: " ", ...s });
        len += 1;
      } else {
        pushWord(p, s);
      }
    }
  }
  if (line.length) lines.push(line);
  return lines.length ? lines : [BLANK];
}

const indent = (lines: Line[], n: number): Line[] => {
  if (n <= 0) return lines;
  const pad: Span = { text: " ".repeat(n) };
  return lines.map((l) => [pad, ...l]);
};

// ── markdown → lines (a pragmatic subset; unknown tokens fall back to text) ──
function inlineSpans(tokens: any[], base: Style): Span[] {
  const out: Span[] = [];
  for (const t of tokens ?? []) {
    switch (t.type) {
      case "strong":
        out.push(...inlineSpans(t.tokens, { ...base, bold: true }));
        break;
      case "em":
        out.push(...inlineSpans(t.tokens, { ...base, italic: true }));
        break;
      case "codespan":
        // No background box: dense paragraphs of `identifiers` become a wall of
        // grey boxes with it. Path-blue alone sets inline code apart — never the
        // bright accent, which is reserved for interactive/now.
        out.push({ text: t.text, color: color.path });
        break;
      case "del":
        out.push(...inlineSpans(t.tokens, { ...base, dim: true }));
        break;
      case "link":
        out.push(...inlineSpans(t.tokens ?? [{ type: "text", text: t.text }], { ...base, color: color.user }));
        break;
      case "br":
        out.push({ text: "\n" });
        break;
      case "escape":
      case "text":
      default:
        out.push(...proseSpans(t.text ?? t.raw ?? "", base));
    }
  }
  return out;
}

// Split spans on hard breaks (\n inside) into multiple span-runs.
function splitHardBreaks(spans: Span[]): Span[][] {
  const runs: Span[][] = [[]];
  for (const s of spans) {
    const segs = s.text.split("\n");
    segs.forEach((seg, i) => {
      if (i > 0) runs.push([]);
      if (seg) runs[runs.length - 1]!.push({ ...s, text: seg });
    });
  }
  return runs;
}

function blockLines(tok: any, width: number): Line[] {
  switch (tok.type) {
    case "space":
      return [BLANK];
    case "heading": {
      const spans = inlineSpans(tok.tokens, { bold: true, color: color.accent });
      return wrapSpans(spans, width);
    }
    case "paragraph": {
      const raw = String(tok.text ?? tok.raw ?? "");
      if (looksLikeLooseCode(raw)) return codeBlockLines(raw, guessCodeLang(raw), width);
      const out: Line[] = [];
      for (const run of splitHardBreaks(inlineSpans(tok.tokens, { color: color.text }))) out.push(...wrapSpans(run.length ? run : BLANK, width));
      return out;
    }
    case "text": {
      const raw = String(tok.text ?? tok.raw ?? "");
      if (looksLikeLooseCode(raw)) return codeBlockLines(raw, guessCodeLang(raw), width);
      const spans = tok.tokens ? inlineSpans(tok.tokens, { color: color.text }) : [{ text: tok.text ?? "", color: color.text }];
      return wrapSpans(spans, width);
    }
    case "code": {
      const lang = String(tok.lang ?? "");
      return codeBlockLines(String(tok.text ?? ""), lang, width);
    }
    case "blockquote": {
      const inner: Line[] = (tok.tokens ?? []).flatMap((t: any) => blockLines(t, Math.max(width - 2, 1)));
      const bar: Span = { text: glyph.quote + " ", color: color.accentDim };
      return inner.map((l) => [bar, ...l]);
    }
    case "hr":
      return [[{ text: glyph.rule.repeat(Math.min(width, 24)), color: color.faint }]];
    case "list": {
      const out: Line[] = [];
      let n = Number(tok.start || 1);
      for (const item of tok.items ?? []) {
        const marker = tok.ordered ? `${n++}. ` : `${glyph.bullet} `;
        const itemSpans = inlineSpans(item.tokens?.find((x: any) => x.type === "text")?.tokens ?? [], { color: color.text });
        const wrapped = wrapSpans(itemSpans.length ? itemSpans : [{ text: item.text ?? "" }], Math.max(width - marker.length, 1));
        wrapped.forEach((l, i) => out.push([{ text: i === 0 ? marker : " ".repeat(marker.length), color: color.accentDim }, ...l]));
      }
      return out;
    }
    case "table": {
      // Aligned columns: size each to its content, shrink to fit width, truncate
      // overflow with "…", preserve inline styling (code/bold) in cells.
      const header = (tok.header ?? []) as any[];
      const rows = (tok.rows ?? []) as any[][];
      const ncols = Math.max(header.length, ...rows.map((r) => r.length), 0);
      if (!ncols) return [];
      const cellSpans = (c: any, base: Style): Span[] =>
        c?.tokens?.length ? inlineSpans(c.tokens, base) : [{ text: String(c?.text ?? ""), ...base }];
      const spanW = (s: Span[]) => s.reduce((n, sp) => n + sp.text.length, 0);
      const head = Array.from({ length: ncols }, (_, ci) => cellSpans(header[ci], { bold: true, color: color.text }));
      const body = rows.map((r) => Array.from({ length: ncols }, (_, ci) => cellSpans(r[ci], { color: color.text })));

      const GAP = 2; // column separator width in spaces
      const natural = Array.from({ length: ncols }, (_, ci) => Math.max(spanW(head[ci]!), ...body.map((r) => spanW(r[ci]!)), 1));
      const avail = Math.max(ncols * 5, width - GAP * (ncols - 1));
      const totalNat = natural.reduce((a, b) => a + b, 0);
      const widths = totalNat <= avail ? natural : natural.map((w) => Math.max(5, Math.floor((w / totalNat) * avail)));

      const padCell = (spans: Span[], w: number): Span[] => {
        if (spanW(spans) > w) {
          const clipped = clipSpans(spans, Math.max(1, w - 1));
          const len = spanW(clipped);
          return [...clipped, { text: "…" + " ".repeat(Math.max(0, w - len - 1)), color: color.faint }];
        }
        const pad = w - spanW(spans);
        return pad > 0 ? [...spans, { text: " ".repeat(pad) }] : spans;
      };
      const joinRow = (cells: Span[][]): Line => {
        const line: Line = [];
        cells.forEach((c, i) => { if (i > 0) line.push({ text: " ".repeat(GAP) }); line.push(...padCell(c, widths[i]!)); });
        return line;
      };
      const out: Line[] = [joinRow(head)];
      out.push([{ text: widths.map((w) => "─".repeat(w)).join("─".repeat(GAP)), color: color.faint }]);
      for (const r of body) out.push(joinRow(r));
      return out;
    }
    default:
      return wrapSpans([{ text: tok.text ?? tok.raw ?? "" }], width);
  }
}

export function markdownToLines(md: string, width: number): Line[] {
  let tokens: any[];
  try {
    tokens = marked.lexer(md);
  } catch {
    return wrapSpans([{ text: md }], width);
  }
  const out: Line[] = [];
  tokens.forEach((t, i) => {
    if (i > 0 && t.type !== "space" && out.length && out[out.length - 1] !== BLANK) {
      // a blank line between blocks (but lexer already emits "space" tokens often)
    }
    out.push(...blockLines(t, width));
  });
  // trim trailing blank lines
  while (out.length && out[out.length - 1]!.length === 0) out.pop();
  return out.length ? out : [BLANK];
}

// ── transcript items → lines ──
// Colored ±counts for the tool head: green adds, red deletes — the glanceable
// "how big was this edit" signal (a la `git diff --stat`).
function diffStatSpans(lines?: { sign: "+" | "-"; text: string }[]): Span[] {
  if (!lines?.length) return [];
  const add = lines.filter((l) => l.sign === "+").length;
  const del = lines.filter((l) => l.sign === "-").length;
  return [
    { text: `  +${add}`, color: color.ok },
    { text: ` −${del}`, color: color.err },
  ];
}

function diffLines(diff: { sign: "+" | "-"; text: string }[], width: number, expand = false): Line[] {
  // Big diffs collapse HARDER: past ~24 changed lines the body is mostly noise
  // in the transcript — show a taste, keep the colored ± header honest, and
  // let ⌃O bring the whole thing back.
  const MAX = expand ? Infinity : diff.length > 24 ? 8 : 16;
  // The opencode diff look: a line-number gutter on its own (darker) tint, a
  // bold +/− marker, then the code on a full-row add/remove tint. The diff
  // strips context lines (src/diff.ts), so the numbers are per-side running
  // counters over the CHANGED lines (old side → −, new side → +), numbered
  // across the whole diff so the collapsed taste matches the expanded view.
  let oldN = 0;
  let newN = 0;
  const numbered = diff.map((d) => ({ ...d, n: d.sign === "+" ? ++newN : ++oldN }));
  const numW = Math.max(2, String(Math.max(oldN, newN, 1)).length);
  const shown = numbered.slice(0, MAX);
  const out: Line[] = shown.map((d) => {
    const add = d.sign === "+";
    const bg = add ? color.diffAddBg : color.diffDelBg;
    const gutterBg = add ? color.diffAddGutterBg : color.diffDelGutterBg;
    const fg = add ? color.ok : color.err;
    const pad = " ".repeat(numW);
    const num = String(d.n).padStart(numW);
    const gutter = ` ${add ? pad : num} ${add ? num : pad} `;
    const contentWidth = Math.max(width - 3 - gutter.length, 1);
    return clipSpans([
      { text: "   ", bg: gutterBg },
      { text: gutter, color: fg, dim: true, bg: gutterBg },
      ...padBg([
        { text: add ? "+ " : "− ", color: fg, bold: true, bg },
        ...highlightLine(d.text).map((s) => ({ ...s, bg })),
      ], contentWidth, bg),
    ], width);
  });
  if (diff.length > MAX) out.push([{ text: `… +${diff.length - MAX} more lines · ⌃O to expand`, color: color.faint }]);
  return out;
}

// Streaming write display: show only a rolling tail so the user watches content
// flow rather than seeing it all dumped at once. `stream` is already bounded
// (App caps it); `count` is the true total line count.
function streamLines(stream: string, count: number, width: number, expand = false): Line[] {
  const TAIL = expand ? 14 : 5;
  const all = stream.split("\n");
  const shown = all.slice(-TAIL);
  const out: Line[] = [];
  if (count > shown.length) out.push([{ text: `… writing ${count} lines${expand ? "" : " · ⌃O to expand"}`, color: color.faint }]);
  for (const l of shown) out.push([{ text: `+ ${l}`.slice(0, width), color: color.ok }]);
  return indent(out, 3);
}

function previewHighlight(line: string, lang: string | undefined, doc: { open: boolean }): Span[] {
  const isPy = /^(py|python)$/i.test(lang ?? "");
  const tripleCount = isPy ? (line.match(/("""|''')/g) ?? []).length : 0;
  if (isPy && (doc.open || tripleCount > 0)) {
    if (tripleCount % 2 === 1) doc.open = !doc.open;
    return [{ text: line, color: color.codeString }];
  }
  return highlightLine(line, lang) as Span[];
}

export const friendlyTool = (name: string) =>
  name === "AskUserQuestion" ? "ask" :
  name === "Write" ? "write" :
  name === "Edit" || name === "MultiEdit" ? "edit" :
  name === "Read" ? "read" :
  name === "Bash" ? "shell" :
  name === "Task" || name === "Agent" ? "agent" :
  name === "TodoWrite" ? "todo" :
  name === "Glob" ? "glob" :
  name === "Grep" ? "search" :
  name === "WebFetch" ? "fetch" :
  name === "WebSearch" ? "search" :
  name === "read_file" ? "read" :
  name === "write_file" ? "write" :
  name === "edit_file" ? "edit" :
  name === "run_shell" ? "shell" :
  name === "command_execution" ? "shell" :
  name === "file_change" ? "write" :
  name === "list_dir" ? "list" :
  name === "glob" ? "glob" :
  name === "search" ? "search" :
  name === "remember" ? "noting" :
  name;

// Strip the CWD prefix so tool args show as relative paths in the transcript.
const CWD = (() => { try { return process.cwd(); } catch { return ""; } })();
export const relPath = (p: string) => (CWD && p.startsWith(CWD + "/") ? p.slice(CWD.length + 1) : p);

// ms → "237ms" / "6.4s" / "6m 7s" — minutes for long runs so a delegate batch
// reads "18m 50s total", not "1130.0s".
const fmtMs = (ms?: number) => ms == null ? "" : ms < 1000 ? `${ms}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
// Coarse elapsed for a still-running step, ticking every second: "8s" or "1m 24s".
export const fmtElapsed = (secs: number) => (secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`);
const toolColor = (it: Extract<Item, { kind: "tool" }>) =>
  it.name === "AskUserQuestion" ? color.accent :
  it.status === "err" ? color.err :
  it.status === "running" ? color.run :
  it.name === "run_shell" || it.name === "command_execution" ? color.accent :
  it.name.toLowerCase().includes("write") || it.name.toLowerCase().includes("edit") || it.name === "file_change" ? color.ok :
  color.accentDim;

// Per-item line cache for the markdown-heavy static kinds (assistant, user).
// Without this, every prior reply is re-parsed on every streaming token, which is
// super-linear with transcript length and caused jittery streaming. Items that are
// unchanged across renders keep a stable object reference (setItems guarantees
// this), so the WeakMap hits for history and misses only for the live tail.
// Tool/phase/etc. items are not cached because they animate (spinner) and are cheap.
// Hex colors are baked into the cached lines, so a /theme switch invalidates via
// themeEpoch — without it, fullscreen history would stay in the old palette.
const staticLineCache = new WeakMap<object, { width: number; epoch: number; lines: Line[] }>();

export function staticItemLines(it: Item, width: number): Line[] {
  const hit = staticLineCache.get(it);
  if (hit && hit.width === width && hit.epoch === themeEpoch) return hit.lines;
  const lines: Line[] = [];
  if (it.kind === "user") {
    // The opencode-style user card: a blue spine running the block's full height
    // (padding rows included), panel background, 2-col inner padding. The
    // assistant's reply renders bare on the canvas — that quiet asymmetry is
    // what makes the dialogue scannable.
    const row = (l: Line): Line =>
      padBg([
        { text: glyph.userBar + "  ", color: color.user, bg: color.userBg },
        ...l.map((s) => ({ ...s, bg: s.bg ?? color.userBg })),
      ], width, color.userBg);
    const wrapped = wrapSpans(proseSpans(it.text, { color: color.text, bg: color.userBg }), Math.max(width - 5, 1));
    // Breathing room only when there's something to breathe around: a one-line
    // message is a single spine row (a 3-row slab for "hi" read as dead space).
    if (wrapped.length > 1) lines.push(row([]));
    for (const l of wrapped) lines.push(row(l));
    if (wrapped.length > 1) lines.push(row([]));
  } else if (it.kind === "assistant" && it.text) {
    lines.push(...indent(markdownToLines(it.text, Math.max(width - 2, 1)), 2));
  }
  staticLineCache.set(it, { width, epoch: themeEpoch, lines });
  return lines;
}

export function itemsToLines(items: Item[], width: number, expand = false): Line[] {
  const out: Line[] = [];
  let prevKind: string | null = null;
  for (const it of items) {
    // Blank line between items, except between consecutive tool calls so a run of
    // reads/edits renders as a tight block rather than a sparse ladder.
    if (!(prevKind === "tool" && it.kind === "tool")) out.push(BLANK);
    prevKind = it.kind;
    if (it.kind === "user" || it.kind === "assistant") {
      out.push(...staticItemLines(it, width));
      continue;
    }
    switch (it.kind) {
      case "tool": {
        // Collapsed delegate_parallel group: ONE summary row that expands (⌃O) to
        // the per-task children — the finished block compacts to a single fact.
        if (it.collapsed) {
          out.push(marginLine([
            { text: "  " },
            { text: it.status === "running" ? glyph.off : glyph.corner, color: it.status === "err" ? color.err : it.status === "running" ? toolColor(it) : color.faint },
            { text: "  " + friendlyTool(it.name), color: color.dim, bold: true },
            ...(it.summary ? [{ text: "  ·  " + it.summary, color: color.dim }] : []),
            ...((it.children?.length ?? 0) ? [{ text: expand ? "  ⌃O collapses" : "  ⌃O expands", color: color.faint }] : []),
          ], it.durationMs != null ? [{ text: "~" + fmtMs(it.durationMs), color: color.faint }] : [], width));
          if (expand && it.children?.length) out.push(...indent(itemsToLines(it.children, Math.max(width - 2, 8), expand), 2));
          break;
        }
        // Corner-glyph stub (the opencode `∟ Edit src/foo.ts` shape) — status
        // carried by the GLYPH's color (purple running, red failed, dim done),
        // the name stays quiet so a run of tools reads as a step list.
        const dot: Span = it.status === "running" ? { text: glyph.off, color: toolColor(it) } : { text: glyph.corner, color: it.status === "err" ? color.err : color.faint };
        const name = friendlyTool(it.name);
        const isShell = it.name === "run_shell" || it.name === "command_execution" || it.name === "Bash";
        const isWrite = !isShell && (it.name.toLowerCase().includes("write") || it.name.toLowerCase().includes("edit") || it.name === "file_change");
        const head: Line = [{ text: "  " }, dot, { text: "  " + name.padEnd(6), color: it.status === "err" ? color.err : color.dim, bold: true }];
        const headUsed = 2 + 1 + 2 + 6; // pad + dot + spaces + name
        if (it.arg) {
          const shownArg = isShell ? it.arg : relPath(it.arg);
          // File-tool heads are clickable: OSC 8 → the configured editor
          // (vscode:// by default; /config editor changes or disables it).
          const link = !isShell && pathish(shownArg) ? editorUrl(shownArg) : undefined;
          head.push({ text: " " + shownArg.slice(0, Math.max(width - headUsed - 1, 0)), color: isShell ? color.text : color.path, bold: true, link });
        }
        if (it.status === "running") {
          // No "working" badge here (it shows once at the bottom) — just the ticking
          // elapsed after ~2 s, the clearest "still running, not hung" per-tool signal.
          const secs = it.startedAt ? Math.floor((Date.now() - it.startedAt) / 1000) : 0;
          if (secs >= 2) head.push({ text: "  " + fmtElapsed(secs), color: color.faint });
        }
        if (it.status !== "running" && it.durationMs != null) head.push({ text: "  " + fmtMs(it.durationMs), color: color.faint });
        if (it.exitCode != null) head.push({ text: "  exit " + it.exitCode, color: it.exitCode === 0 ? color.faint : color.err });
        if (it.diff?.length) head.push(...diffStatSpans(it.diff));
        // For clean completed tools (no preview, no output, no diff) put the
        // summary inline on the head so consecutive reads render as a tight block.
        const redundantSummary = it.summary != null && (it.summary === it.name || it.summary.toLowerCase() === name);
        const hasExtraOutput = !!(it.preview || (it.outputTail ?? it.stream) || it.diff?.length);
        const inlineSummary = it.status !== "running" && it.summary && !redundantSummary && !hasExtraOutput && !(isShell && (it.outputTail ?? it.stream));
        if (inlineSummary) {
          head.push({ text: "  " + it.summary, color: it.status === "err" ? color.err : color.dim });
          out.push(clipSpans(head, width));
        } else {
          out.push(head);
        }
        if (it.status === "running" && it.activity) {
          // Single replacing status line for delegate progress, not a growing log.
          out.push(...indent([clipSpans([{ text: "└─ ", color: color.accentDim }, { text: it.activity, color: color.dim }], Math.max(width - 3, 8))], 3));
        } else if (it.status === "running" && !it.outputTail && !it.stream) {
          out.push(...indent([[
            { text: "└─ ", color: color.accentDim },
            { text: isWrite ? "drafting file · no code streamed yet" : isShell ? "waiting for output" : "no output yet", color: color.faint },
          ]], 3));
        }
        if (it.preview) {
          const lines = it.preview.split("\n");
          const shown = expand ? lines : lines.slice(0, 8);
          const codeWidth = Math.max(width - 6, 24);
          const docState = { open: false };
          out.push(...indent([padBg([
            { text: "┌─ ", color: color.accentDim, bg: color.codeBg },
            { text: expand ? "full code" : "preview", color: color.accent, bold: true, bg: color.codeBg },
            { text: expand ? ` · ${it.previewLines ?? lines.length} lines` : ` · ${shown.length} of ${it.previewLines ?? "?"} shown`, color: color.faint, bg: color.codeBg },
          ], codeWidth, color.codeBg)], 3));
          for (let i = 0; i < shown.length; i++) {
            out.push(padBg(clipSpans([
              { text: "   │ ", color: color.accentDim, bg: color.codeBg },
              { text: String(i + 1).padStart(2) + " ", color: color.faint, bg: color.codeBg },
              { text: "│ ", color: color.accentDim, bg: color.codeBg },
              ...previewHighlight(shown[i]!, it.previewLang, docState).map((s) => ({ ...s, bg: color.codeBg })),
            ], codeWidth), codeWidth, color.codeBg));
          }
          out.push(...indent([padBg([
            { text: "└─ ", color: color.accentDim, bg: color.codeBg },
            { text: (it.previewLines ?? 0) > shown.length ? "⌃O expands full code" : expand ? "⌃O collapses preview" : "", color: color.faint, bg: color.codeBg },
          ], codeWidth, color.codeBg)], 3));
        }
        const outTail = it.outputTail ?? it.stream;
        const outCount = it.outputLines ?? it.streamCount ?? 0;
        if (outTail) {
          if (it.name === "run_shell" || it.name === "command_execution") {
            const tail = expand ? 14 : 5;
            const shown = outTail.split("\n").filter(Boolean).slice(-tail);
            if (outCount > shown.length) out.push(...indent([[{ text: `… ${outCount} lines${expand ? "" : " · ⌃O to expand"}`, color: color.faint }]], 3));
            out.push(...indent(shown.map((l) => [{ text: `│ ${l}`.slice(0, Math.max(width - 5, 1)), color: color.dim }]), 3));
          } else {
            out.push(...streamLines(outTail, outCount, Math.max(width - 5, 1), expand));
          }
        }
        // Summary as a separate line only for tools that have extra output (shell,
        // write/edit with diff, preview). Simple reads/searches already put it inline.
        if (!inlineSummary && it.status !== "running" && it.summary && !redundantSummary && !(isShell && outTail)) {
          out.push([{ text: "   " + glyph.result + " ", color: color.faint }, { text: it.summary.slice(0, Math.max(width - 5, 1)), color: it.status === "err" ? color.err : color.dim }]);
        }
        if (it.diff?.length) out.push(...diffLines(it.diff, width, expand));
        break;
      }
      case "phase": {
        const mark = it.state === "running" ? "◌ " : it.state === "ok" ? "✓ " : "▲ ";
        const c = it.state === "err" ? color.err : it.state === "ok" ? color.ok : color.accentDim;
        out.push(clipSpans([{ text: "  " }, { text: mark, color: c }, { text: it.label, color: it.state === "running" ? color.text : color.dim }, ...(it.detail ? [{ text: " · " + it.detail, color: color.faint }] : [])], width));
        break;
      }
      case "model": {
        // Post-turn provenance line. Dim when routine; brightens to amber with a
        // reason for the three "surprising" cases (escalation, fallback, cap hit).
        const head = it.surprising ? color.warn : color.faint;
        const body = it.surprising ? color.warn : color.dim;
        const spans = [
          { text: "  ↳ ", color: head },
          { text: it.provider + " · " + it.model, color: body },
        ];
        if (it.surprising && it.reason) spans.push({ text: " · " + it.reason, color: color.warn });
        out.push(marginLine(spans, it.costText ? [{ text: it.costText, color: head }] : [], width));
        break;
      }
      case "verification": {
        // Durable one-liner: named action, final state, attempts folded in.
        // The literal command and output are hidden behind ⌃O (expand).
        const label = it.intent ?? "check";
        const state = it.ok ? "passed" : "failed";
        const head: Line = [
          { text: "  " + (it.ok ? glyph.tool + " " : "▲ "), color: it.ok ? color.ok : color.err },
          { text: label, color: color.text, bold: true },
          { text: " · " + state, color: it.ok ? color.ok : color.err },
        ];
        const vFigs: Span[] = it.durationMs != null ? [{ text: fmtMs(it.durationMs), color: color.faint }] : [];
        const retry = retryPhrase(it.ok, it.attempts ?? 1);
        // A retry is a real event — elevate it (amber + ⚠), don't bury it in faint grey.
        if (retry) head.push({ text: " · ⚠ " + retry, color: color.warn, bold: true });
        if (!it.ok && it.summary) head.push({ text: " · " + it.summary, color: color.err });
        const body = it.output ?? "";
        if (body && (it.command || it.output)) head.push({ text: "  ⌃O for output", color: color.faint });
        out.push(marginLine(head, vFigs, width));
        if (expand && (it.command || body)) {
          if (it.command) out.push(...indent([[{ text: "$ " + it.command, color: color.dim }]], 4));
          const lines = body.split("\n").filter(Boolean).slice(-14);
          out.push(...indent(lines.map((l) => [{ text: "│ " + l, color: color.dim }]), 4));
        }
        break;
      }
      case "preference": {
        out.push(clipSpans([{ text: "  " + glyph.notice + " ", color: color.accentDim }, { text: it.text, color: color.text }, { text: " · " + it.acceptCommand, color: color.faint }], width));
        break;
      }
      case "summary": {
        const bits: string[] = [];
        if (it.changed.length) bits.push(`${it.changed.length} file${it.changed.length === 1 ? "" : "s"}`);
        if (it.checks.length) bits.push(`${it.checks.length} check${it.checks.length === 1 ? "" : "s"}`);
        if (it.failures.length) bits.push(`${it.failures.length} failed`);
        // Which verification tier the turn cleared: tests > types > none.
        const proof =
          it.tier === "tests" ? { text: " · tests green", color: color.ok }
          : it.tier === "types" ? { text: " · types/build pass", color: color.ok }
          : it.tier === "none" ? { text: " · unverified", color: color.faint }
          : null;
        out.push(clipSpans([
          { text: "  " + (it.failures.length ? glyph.err + " " : glyph.check + " "), color: it.failures.length ? color.warn : color.ok },
          { text: "turn summary", color: color.text },
          ...(bits.length ? [{ text: " · " + bits.join(" · "), color: color.faint }] : []),
          ...(proof ? [proof] : []),
        ], width));
        if (it.changed.length) out.push(clipSpans([{ text: "    changed ", color: color.faint }, { text: it.changed.slice(0, 4).join(", ") + (it.changed.length > 4 ? ` +${it.changed.length - 4}` : ""), color: color.path }], width));
        if (it.next) out.push(clipSpans([{ text: "    next ", color: color.dim }, { text: it.next, color: color.accent }], width));
        break;
      }
      case "notice": {
        // Preserve source newlines (e.g. `!cat` output) and wrap long lines.
        let first = true;
        for (const para of it.text.split("\n")) {
          const wrapped = wrapSpans(noticeSpans(para), Math.max(width - 4, 1));
          wrapped.forEach((l) => {
            out.push([{ text: first ? "  " + glyph.notice + " " : "    ", color: color.accentDim }, ...l]);
            first = false;
          });
        }
        break;
      }
      case "accounts": {
        const v = it.view;
        out.push([{ text: "  " + glyph.notice + " ", color: color.accentDim }, { text: "accounts", color: color.text }, { text: " · current ", color: color.faint }, { text: v.current, color: color.text, bold: true }]);
        const commandWidth = Math.max(18, ...v.rows.map((r) => `/account ${r.alias}`.length));
        const emitGroup = (title: string, rows: typeof v.rows) => {
          if (!rows.length) return;
          out.push(BLANK);
          out.push([{ text: "  " + title, color: color.faint }]);
          for (const r of rows) {
            const cmd = `/account ${r.alias}`;
            out.push(clipSpans([
              { text: r.active ? "  ● " : "    ", color: r.active ? color.ok : color.faint },
              { text: r.name.padEnd(v.labelPad), color: color.text, bold: r.active },
              { text: "  " + r.status.padEnd(v.statusPad), color: accountStateColor(r.status) },
              { text: "  use ", color: color.faint },
              { text: cmd.padEnd(commandWidth), color: color.accent, bold: true, bg: color.accentBg },
            ], width));
            if (r.duplicateOf) out.push(clipSpans([{ text: "      same login as ", color: color.faint }, { text: r.duplicateOf, color: color.text }], width));
            else if (r.detail) out.push(clipSpans([{ text: "      " + r.detail, color: color.faint }], width));
          }
        };
        emitGroup("subscriptions", v.rows.filter((r) => r.type === "subscription"));
        emitGroup("api keys", v.rows.filter((r) => r.type === "API key"));
        if (v.importable.length) {
          out.push(BLANK);
          out.push([{ text: "  importable", color: color.faint }]);
          for (const c of v.importable) out.push(clipSpans([{ text: "    " + c.label, color: color.text }, { text: "  " + c.envVar + "  ", color: color.faint }, { text: "/account import", color: color.accent }], width));
        }
        out.push(BLANK);
        out.push(clipSpans([{ text: "  add     ", color: color.faint }, { text: "/account add codex [name]", color: color.accent }, { text: "   /account add claude [name]", color: color.accent }, { text: "   /account add <api-key>", color: color.accent }], width));
        out.push(clipSpans([{ text: "  remove  ", color: color.faint }, { text: "/account remove <name>", color: color.accent }], width));
        break;
      }
      case "usage": {
        const v = it.view;
        out.push([{ text: "  " + glyph.notice + " ", color: color.accentDim }, { text: "usage ", color: color.text }, { text: "· spend & limits (all sessions)", color: color.faint }]);
        if (v.subscriptions.length) {
          out.push(BLANK);
          out.push([{ text: "  subscriptions", color: color.faint }]);
          for (const a of v.subscriptions) {
            const line: Line = [{ text: "    " + a.name.padEnd(v.labelPad), color: color.text }, { text: "  " + a.turns + " turn" + (a.turns === 1 ? "" : "s"), color: color.faint }];
            if (a.limits?.length) {
              const l = a.limits[0]!;
              line.push({ text: "    " + l.label + " ", color: color.faint }, ...limitValueSpans(l));
              if (l.resetsIn) line.push({ text: " · " + l.resetsIn, color: color.faint });
            } else {
              line.push({ text: "    " + (a.limitNote ?? "limits not observed yet"), color: color.faint });
            }
            out.push(clipSpans(line, width));
            for (const l of a.limits?.slice(1) ?? []) {
              out.push(clipSpans([
                { text: "    " + "".padEnd(v.labelPad), color: color.text },
                { text: "       ", color: color.faint },
                { text: "    " + l.label + " ", color: color.faint },
                ...limitValueSpans(l),
                ...(l.resetsIn ? [{ text: " · " + l.resetsIn, color: color.faint }] : []),
              ], width));
            }
          }
        }
        if (v.apiKeys.length) {
          out.push(BLANK);
          out.push([{ text: "  api keys", color: color.faint }]);
          for (const a of v.apiKeys) {
            out.push(
              clipSpans(
                [
                  { text: "    " + a.name.padEnd(v.labelPad), color: color.text },
                  { text: "  " + (a.spend ?? "").padStart(v.spendPad), color: a.spendPos ? color.text : color.faint },
                  { text: "   " + a.turns + " turn" + (a.turns === 1 ? "" : "s") + " · " + a.tok, color: color.faint },
                  ...(a.balanceLeft ? [{ text: " · " + a.balanceLeft, color: color.faint }] : []),
                  ...(a.balanceNote ? [{ text: " · " + a.balanceNote, color: color.faint }] : []),
                ],
                width,
              ),
            );
          }
        }
        out.push(BLANK);
        const totalLine: Line = [{ text: "  total API spend ", color: color.dim }, { text: v.totalApiSpend, color: color.text }];
        if (v.sessionUSD) totalLine.push({ text: "   ·   this session " + v.sessionUSD, color: color.faint });
        out.push(clipSpans(totalLine, width));
        if (v.hasEstimate) out.push([{ text: "  ~ estimated (provider didn't report an exact cost)", color: color.faint }]);
        break;
      }
      case "context": {
        const v = it.view;
        out.push([{ text: "  " + glyph.notice + " ", color: color.accentDim }, { text: "context · what's loaded for the next message", color: color.text }]);
        out.push(BLANK);
        for (const r of v.rows) {
          const { fill, empty } = barCells(r.frac, 18);
          out.push(
            clipSpans(
              [
                { text: "  " + r.label.padEnd(v.labelPad), color: color.dim },
                { text: "  " + r.display.padStart(v.valuePad) + "  ", color: color.text },
                { text: fill, color: color.accent },
                { text: empty, color: color.faint },
                ...(r.pct != null ? [{ text: " " + r.pct + "% of window", color: color.faint }] : []),
              ],
              width,
            ),
          );
        }
        out.push(BLANK);
        const totalLine: Line = [{ text: "  " + "total".padEnd(v.labelPad) + "  " + v.total.padStart(v.valuePad) + "  ", color: color.text }];
        if (v.windowPct != null) {
          const win = barCells(v.windowPct / 100, 18);
          totalLine.push({ text: win.fill, color: limitColor(v.windowPct) }, { text: win.empty, color: color.faint }, { text: " " + v.windowPct + "% of " + v.windowLabel, color: limitColor(v.windowPct) });
        }
        out.push(clipSpans(totalLine, width));
        if (v.cwd) out.push(clipSpans([{ text: "  working directory: " + v.cwd, color: color.faint }], width));
        break;
      }
      case "scorecard": {
        const toneColor: Record<string, string> = { title: color.text, colhead: color.faint, chosen: color.accent, row: color.dim, dim: color.faint, note: color.faint };
        let first = true;
        for (const r of scorecardRows(it.card)) {
          const prefix = first ? "  " + glyph.notice + " " : "    ";
          out.push(clipSpans([{ text: prefix, color: color.accentDim }, { text: r.text, color: toneColor[r.tone] ?? color.text }], width));
          if (first) out.push(BLANK);
          first = false;
        }
        break;
      }
      case "error": {
        // Red left-bar spine (▎) mirroring the user spine, without a floating box.
        out.push(BLANK);
        for (const para of it.text.split("\n")) {
          const wrapped = wrapSpans([{ text: para, color: color.err }], Math.max(width - 2, 1));
          wrapped.forEach((l) => {
            out.push([{ text: glyph.quote + " ", color: color.err }, ...l]);
          });
        }
        break;
      }
    }
  }
  return out;
}
