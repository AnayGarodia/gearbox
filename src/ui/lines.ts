// The transcript as a flat list of styled lines. This is what makes a real
// fullscreen scroll region possible: we render only the slice of lines that fits
// the viewport, so the frame is NEVER taller than the screen (Ink's own
// flex/overflow clipping is unreliable and corrupts on tall content). Each Line
// is a list of Spans (text + Ink-native style) — never raw ANSI, which would
// break Ink's width math. Wrapping happens here, at a known width, so every Line
// is exactly one terminal row.
import { marked } from "marked";
import { color } from "./theme.ts";
import { glyph } from "./theme.ts";
import { highlightLine } from "./highlight.ts";
import type { Item } from "./types.ts";
import { barCells } from "../accounts/usage.ts";
import { retryPhrase } from "./collapse.ts";
import { scorecardRows } from "../commands.ts";
import { PROSE_RE, proseTokenStyle } from "./prose.ts";

const limitColor = (pct: number) => (pct >= 85 ? color.err : pct >= 60 ? color.accent : color.ok);
// A limit window's value: a utilization bar when a % is known, else the status word.
const limitValueSpans = (l: { pct?: number; status?: "ok" | "warn" | "limited" }): Span[] => {
  if (typeof l.pct === "number") {
    const lim = barCells(l.pct / 100, 10);
    return [{ text: lim.fill, color: limitColor(l.pct) }, { text: lim.empty, color: color.faint }, { text: " " + l.pct + "%", color: limitColor(l.pct) }];
  }
  const c = l.status === "limited" ? color.err : l.status === "warn" ? color.accent : color.ok;
  return [{ text: l.status === "limited" ? "limited" : l.status === "warn" ? "near limit" : "ok", color: c }];
};
const accountStateColor = (status: string) =>
  status === "active" || status === "signed in" || status === "ready" || status.startsWith("✓") ? color.ok :
  status === "duplicate" ? color.accent :
  status === "not signed in" || status.startsWith("✗") ? color.run :
  status.startsWith("⚠") || status.startsWith("⏳") ? color.accent :
  color.faint;

export type Span = { text: string; color?: string; bold?: boolean; italic?: boolean; dim?: boolean; bg?: string };
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
    out.push(padBg([{ text: ` ${lang} `, color: color.accent, bold: true, bg: color.codeBg }], blockWidth, color.codeBg));
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

// Prose highlighting: rich but precise. The token set + per-token style live in
// the shared tokenizer (prose.ts) so this and the inline path (Markdown.tsx) can
// never drift. Each match is anchored/bounded so ordinary English stays plain.
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
  const re = /(\/[a-z][\w-]*(?:\s+[^\s]+)?|\b(?:Claude|ChatGPT|Anthropic|OpenAI|OpenRouter|subscription|API key|active|current|switch|add|remove|use)\b|\b\d+\.\b|\b\/account\s+\d+\b|`[^`]+`)/gi;
  let last = 0;
  for (const m of text.matchAll(re)) {
    const idx = m.index ?? 0;
    const token = m[0]!;
    if (idx > last) out.push({ text: text.slice(last, idx), color: color.dim });
    const low = token.toLowerCase();
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
        // Color only, no background box — a dense paragraph of `identifiers` (a
        // coverage report, a gap list) turned into a wall of grey boxes. The
        // accent/path color is enough to set inline code apart from prose.
        out.push({ text: t.text, color: /[/\\.]/.test(String(t.text ?? "")) ? color.path : color.accent });
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
      const bar: Span = { text: glyph.userBar + " ", color: color.accentDim };
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
      // Aligned columns (was: cells flattened to a "·"-joined run that wrapped into
      // an unreadable blob). Size each column to its content, shrink to fit width,
      // truncate overflow with "…", keep inline styling (code/bold) in cells.
      const header = (tok.header ?? []) as any[];
      const rows = (tok.rows ?? []) as any[][];
      const ncols = Math.max(header.length, ...rows.map((r) => r.length), 0);
      if (!ncols) return [];
      const cellSpans = (c: any, base: Style): Span[] =>
        c?.tokens?.length ? inlineSpans(c.tokens, base) : [{ text: String(c?.text ?? ""), ...base }];
      const spanW = (s: Span[]) => s.reduce((n, sp) => n + sp.text.length, 0);
      const head = Array.from({ length: ncols }, (_, ci) => cellSpans(header[ci], { bold: true, color: color.text }));
      const body = rows.map((r) => Array.from({ length: ncols }, (_, ci) => cellSpans(r[ci], { color: color.text })));

      const GAP = 2; // spaces between columns
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
function diffStats(lines?: { sign: "+" | "-"; text: string }[]): string {
  if (!lines?.length) return "";
  const add = lines.filter((l) => l.sign === "+").length;
  const del = lines.filter((l) => l.sign === "-").length;
  return `+${add} -${del}`;
}

function diffLines(diff: { sign: "+" | "-"; text: string }[], width: number, expand = false): Line[] {
  const MAX = expand ? Infinity : 16;
  const shown = diff.slice(0, MAX);
  const contentWidth = Math.max(width - 3, 1);
  const out: Line[] = shown.map((d) => {
    const bg = d.sign === "+" ? color.diffAddBg : color.diffDelBg;
    const fg = d.sign === "+" ? color.ok : color.err;
    return [
      { text: "   ", bg },
      ...padBg(clipSpans([
      { text: d.sign === "+" ? "+ " : "− ", color: fg, bold: true, bg },
      ...highlightLine(d.text).map((s) => ({ ...s, bg })),
      ], contentWidth), contentWidth, bg),
    ];
  });
  if (diff.length > MAX) out.push([{ text: `… +${diff.length - MAX} more lines · ⌃O to expand`, color: color.faint }]);
  return out;
}

// A file being written, streamed live: a scrolling TAIL window of the content so
// the user watches it flow by instead of seeing it dumped (or truncated) at once.
// `stream` is already a bounded tail (App caps it); `count` is the true total.
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

const friendlyTool = (name: string) =>
  name === "AskUserQuestion" ? "question" :
  name === "Write" ? "write" :
  name === "Edit" ? "edit" :
  name === "Read" ? "read" :
  name === "Bash" ? "shell" :
  name === "read_file" ? "read" :
  name === "write_file" ? "write" :
  name === "edit_file" ? "edit" :
  name === "run_shell" ? "shell" :
  name === "command_execution" ? "shell" :
  name === "file_change" ? "write" :
  name === "list_dir" ? "list" :
  name === "glob" ? "glob" :
  name === "search" ? "search" :
  name;

const fmtMs = (ms?: number) => ms == null ? "" : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
const motionFrame = () => Math.floor(Date.now() / 360);
const spinnerFrame = () => ["●", "◌", "○", "◌"][motionFrame() % 4]!;
const activePhrase = (label: string) => `${label}${["", ".", "..", "..."][motionFrame() % 4]}`;
const toolColor = (it: Extract<Item, { kind: "tool" }>) =>
  it.name === "AskUserQuestion" ? color.accent :
  it.status === "err" ? color.err :
  it.status === "running" ? color.run :
  it.name === "run_shell" || it.name === "command_execution" ? color.accent :
  it.name.toLowerCase().includes("write") || it.name.toLowerCase().includes("edit") || it.name === "file_change" ? color.ok :
  color.accentDim;

/** Flatten the transcript into styled lines wrapped to `width`. A leading blank
 *  line separates turns (so the windowed view keeps its rhythm). */
// Per-item line cache for the two markdown-heavy, static kinds (assistant, user).
// Streaming re-runs itemsToLines on every token; without this, every prior reply's
// markdown is re-parsed each token (super-linear with transcript length — the
// cause of jittery streaming). Items keep a stable object reference across renders
// when unchanged (setItems maps unchanged items to the same object), so a WeakMap
// keyed by item reference hits for history and misses only for the changing tail.
// Tool/phase/etc. items are NOT cached — they can animate (spinner) and are cheap.
const staticLineCache = new WeakMap<object, { width: number; lines: Line[] }>();

export function staticItemLines(it: Item, width: number): Line[] {
  const hit = staticLineCache.get(it);
  if (hit && hit.width === width) return hit.lines;
  const lines: Line[] = [];
  if (it.kind === "user") {
    const wrapped = wrapSpans(proseSpans(it.text, { color: color.user, bold: true, bg: color.userBg }), Math.max(width - 4, 1));
    wrapped.forEach((l, i) =>
      lines.push(padBg([
        { text: i === 0 ? "▌ " : "  ", color: color.accent, bold: true, bg: color.userBg },
        ...l.map((s) => ({ ...s, bg: color.userBg })),
      ], width, color.userBg)),
    );
  } else if (it.kind === "assistant" && it.text) {
    lines.push(...indent(markdownToLines(it.text, Math.max(width - 2, 1)), 2));
  }
  staticLineCache.set(it, { width, lines });
  return lines;
}

export function itemsToLines(items: Item[], width: number, expand = false): Line[] {
  const out: Line[] = [];
  let prevKind: string | null = null;
  for (const it of items) {
    // One blank line separates items — EXCEPT between consecutive tool calls, so a
    // run of reads/edits reads as one tight block instead of a sparse ladder.
    if (!(prevKind === "tool" && it.kind === "tool")) out.push(BLANK);
    prevKind = it.kind;
    if (it.kind === "user" || it.kind === "assistant") {
      out.push(...staticItemLines(it, width));
      continue;
    }
    switch (it.kind) {
      case "tool": {
        const dot: Span = { text: it.status === "running" ? spinnerFrame() : glyph.tool, color: toolColor(it) };
        const name = friendlyTool(it.name);
        const isShell = it.name === "run_shell" || it.name === "command_execution" || it.name === "Bash";
        const isWrite = !isShell && (it.name.toLowerCase().includes("write") || it.name.toLowerCase().includes("edit") || it.name === "file_change");
        const head: Line = [{ text: "  " }, dot, { text: "  " + name.padEnd(6), color: toolColor(it), bold: true }];
        const headUsed = 2 + 1 + 2 + 6; // pad + dot + spaces + name
        if (it.arg) head.push({ text: " " + it.arg.slice(0, Math.max(width - headUsed - 1, 0)), color: isShell ? color.text : color.path, bold: true });
        if (it.status === "running") head.push({ text: "  " + activePhrase(isWrite ? "writing" : isShell ? "running" : "working"), color: color.run, bg: color.panelBg });
        if (it.status !== "running" && it.durationMs != null) head.push({ text: "  " + fmtMs(it.durationMs), color: color.faint });
        if (it.exitCode != null) head.push({ text: "  exit " + it.exitCode, color: it.exitCode === 0 ? color.faint : color.err });
        if (it.diff?.length) head.push({ text: "  " + diffStats(it.diff), color: color.faint });
        out.push(head);
        if (it.status === "running" && !it.outputTail && !it.stream) {
          out.push(...indent([[
            { text: "└─ ", color: color.accentDim },
            { text: activePhrase(isWrite ? "drafting file" : "waiting"), color: color.ok, bg: color.panelBg },
            { text: " " + (isWrite ? "provider has not streamed code yet" : "waiting for tool output"), color: color.faint },
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
        // The summary line repeats the tool's headline result. For a shell that's
        // the first output line, which we already render in the tail above — so
        // skip it for shells (it read as `$ tsc --noEmit` printed twice).
        if (it.status !== "running" && it.summary && !(isShell && outTail)) {
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
        // Post-turn provenance: routed → provider · model · cost. Dim when routine;
        // the whole line brightens to warn (amber) + a reason for a surprising pick.
        const head = it.surprising ? color.warn : color.faint;
        const body = it.surprising ? color.warn : color.dim;
        const spans = [
          { text: "  ↳ routed → ", color: head },
          { text: it.provider + " · " + it.model, color: body },
        ];
        if (it.costText) spans.push({ text: " · " + it.costText, color: head });
        if (it.surprising && it.reason) spans.push({ text: " · " + it.reason, color: color.warn });
        out.push(clipSpans(spans, width));
        break;
      }
      case "verification": {
        // Durable one-liner: the named action + final state, attempts folded in.
        // The literal command + output live behind ⌃O (expand), not in the spine.
        const label = it.intent ?? "check";
        const state = it.ok ? "passed" : "failed";
        const head: Line = [
          { text: "  " + (it.ok ? glyph.tool + " " : "▲ "), color: it.ok ? color.ok : color.err },
          { text: label, color: color.text, bold: true },
          { text: " · " + state, color: it.ok ? color.ok : color.err },
        ];
        if (it.durationMs != null) head.push({ text: " in " + fmtMs(it.durationMs), color: color.faint });
        const retry = retryPhrase(it.ok, it.attempts ?? 1);
        if (retry) head.push({ text: " · " + retry, color: color.faint });
        if (!it.ok && it.summary) head.push({ text: " · " + it.summary, color: color.err });
        const body = it.output ?? "";
        if (body && (it.command || it.output)) head.push({ text: "  ⌃O for output", color: color.faint });
        out.push(clipSpans(head, width));
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
        out.push(clipSpans([
          { text: "  " + (it.failures.length ? "◇ " : "✓ "), color: it.failures.length ? color.accentDim : color.ok },
          { text: "turn summary", color: color.text },
          ...(bits.length ? [{ text: " · " + bits.join(" · "), color: color.faint }] : []),
        ], width));
        if (it.changed.length) out.push(clipSpans([{ text: "    changed ", color: color.faint }, { text: it.changed.slice(0, 4).join(", ") + (it.changed.length > 4 ? ` +${it.changed.length - 4}` : ""), color: color.path }], width));
        if (it.next) out.push(clipSpans([{ text: "    next ", color: color.dim }, { text: it.next, color: color.accent }], width));
        break;
      }
      case "notice": {
        // Preserve source newlines (e.g. `!cat file` output), wrapping long ones.
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
                  { text: "  " + (a.spend ?? "").padStart(v.spendPad), color: a.spendPos ? color.ok : color.faint },
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
        let first = true;
        for (const para of it.text.split("\n")) {
          const wrapped = wrapSpans([{ text: para, color: color.err }], Math.max(width - 4, 1));
          wrapped.forEach((l) => {
            out.push([{ text: first ? "  " + glyph.err + " " : "    ", color: color.err }, ...l]);
            first = false;
          });
        }
        break;
      }
    }
  }
  return out;
}
