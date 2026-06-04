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

const limitColor = (pct: number) => (pct >= 90 ? color.err : pct >= 70 ? color.accent : color.ok);

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

type Style = Omit<Span, "text">;

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
        out.push({ text: t.text, color: color.accent });
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
        out.push({ text: t.text ?? t.raw ?? "", ...base });
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
      const out: Line[] = [];
      for (const run of splitHardBreaks(inlineSpans(tok.tokens, {}))) out.push(...wrapSpans(run.length ? run : BLANK, width));
      return out;
    }
    case "text": {
      const spans = tok.tokens ? inlineSpans(tok.tokens, {}) : [{ text: tok.text ?? "" }];
      return wrapSpans(spans, width);
    }
    case "code": {
      const lang = String(tok.lang ?? "");
      const lines = String(tok.text ?? "").split("\n");
      return lines.map((l) => clipSpans(highlightLine(l, lang) as Span[], width));
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
        const itemSpans = inlineSpans(item.tokens?.find((x: any) => x.type === "text")?.tokens ?? [], {});
        const wrapped = wrapSpans(itemSpans.length ? itemSpans : [{ text: item.text ?? "" }], Math.max(width - marker.length, 1));
        wrapped.forEach((l, i) => out.push([{ text: i === 0 ? marker : " ".repeat(marker.length), color: color.accentDim }, ...l]));
      }
      return out;
    }
    case "table": {
      const row = (cells: any[]) => cells.map((c) => (c.text ?? "")).join("  ·  ");
      const out: Line[] = [];
      out.push(...wrapSpans([{ text: row(tok.header ?? []), bold: true }], width));
      for (const r of tok.rows ?? []) out.push(...wrapSpans([{ text: row(r) }], width));
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
function diffLines(diff: { sign: "+" | "-"; text: string }[], width: number, expand = false): Line[] {
  const MAX = expand ? Infinity : 16;
  const shown = diff.slice(0, MAX);
  const out: Line[] = shown.map((d) => [{ text: `${d.sign === "+" ? "+" : "−"} ${d.text}`.slice(0, width), color: d.sign === "+" ? color.ok : color.err }]);
  if (diff.length > MAX) out.push([{ text: `… +${diff.length - MAX} more lines · ⌃O to expand`, color: color.faint }]);
  return indent(out, 3);
}

// A file being written, streamed live: a scrolling TAIL window of the content so
// the user watches it flow by instead of seeing it dumped (or truncated) at once.
// `stream` is already a bounded tail (App caps it); `count` is the true total.
function streamLines(stream: string, count: number, width: number): Line[] {
  const TAIL = 14;
  const all = stream.split("\n");
  const shown = all.slice(-TAIL);
  const out: Line[] = [];
  if (count > shown.length) out.push([{ text: `… writing ${count} lines`, color: color.faint }]);
  for (const l of shown) out.push([{ text: `+ ${l}`.slice(0, width), color: color.ok }]);
  return indent(out, 3);
}

/** Flatten the transcript into styled lines wrapped to `width`. A leading blank
 *  line separates turns (so the windowed view keeps its rhythm). */
export function itemsToLines(items: Item[], width: number, expand = false): Line[] {
  const out: Line[] = [];
  for (const it of items) {
    out.push(BLANK);
    switch (it.kind) {
      case "user": {
        const wrapped = wrapSpans([{ text: it.text, color: color.user }], Math.max(width - 2, 1));
        wrapped.forEach((l, i) => out.push([{ text: i === 0 ? glyph.userBar + " " : "  ", color: color.user }, ...l]));
        break;
      }
      case "assistant": {
        if (!it.text) break;
        out.push(...indent(markdownToLines(it.text, Math.max(width - 2, 1)), 2));
        break;
      }
      case "tool": {
        const dot: Span = { text: glyph.tool, color: it.status === "err" ? color.err : color.accent };
        const head: Line = [{ text: "  " }, dot, { text: "  " + it.name.padEnd(5), color: color.dim }];
        const headUsed = 2 + 1 + 2 + 5; // pad + dot + spaces + name
        if (it.arg) head.push({ text: " " + it.arg.slice(0, Math.max(width - headUsed - 1, 0)), color: color.text });
        if (it.status === "running") head.push({ text: "  …", color: color.faint });
        out.push(head);
        if (it.status === "running" && it.stream) out.push(...streamLines(it.stream, it.streamCount ?? 0, Math.max(width - 5, 1)));
        if (it.status !== "running" && it.summary) {
          out.push([{ text: "   " + glyph.result + " ", color: color.faint }, { text: it.summary.slice(0, Math.max(width - 5, 1)), color: it.status === "err" ? color.err : color.dim }]);
        }
        if (it.diff?.length) out.push(...diffLines(it.diff, Math.max(width - 5, 1), expand));
        break;
      }
      case "notice": {
        // Preserve source newlines (e.g. `!cat file` output), wrapping long ones.
        let first = true;
        for (const para of it.text.split("\n")) {
          const wrapped = wrapSpans([{ text: para, color: color.dim }], Math.max(width - 4, 1));
          wrapped.forEach((l) => {
            out.push([{ text: first ? "  " + glyph.notice + " " : "    ", color: color.accentDim }, ...l]);
            first = false;
          });
        }
        break;
      }
      case "usage": {
        const v = it.view;
        out.push([{ text: "  " + glyph.notice + " ", color: color.accentDim }, { text: "cost · spend per account ", color: color.text }, { text: "(all sessions)", color: color.faint }]);
        out.push(BLANK);
        for (const r of v.rows) {
          const zero = r.spend.trim().startsWith("$0.00");
          const { fill, empty } = barCells(r.spendFrac, v.barWidth);
          const line: Line = [
            { text: "  " + r.name, color: color.text },
            { text: "  " + r.spend + "  ", color: zero ? color.faint : color.ok },
            { text: fill, color: color.accent },
            { text: empty, color: color.faint },
            { text: "  " + r.meta, color: color.faint },
          ];
          if (r.limitPct != null) {
            const lim = barCells(r.limitPct / 100, 6);
            line.push({ text: "   " + (r.limitLabel ?? "") + " ", color: color.faint }, { text: lim.fill, color: limitColor(r.limitPct) }, { text: lim.empty, color: color.faint }, { text: " " + r.limitPct + "%", color: limitColor(r.limitPct) });
          }
          out.push(clipSpans(line, width));
        }
        out.push(BLANK);
        const totalLine: Line = [{ text: "  total  ", color: color.dim }, { text: v.total.trim(), color: color.text }];
        if (v.sessionUSD) totalLine.push({ text: "     this session (est): " + v.sessionUSD, color: color.faint });
        out.push(clipSpans(totalLine, width));
        if (v.hasEstimate) out.push([{ text: "  ~ estimated (provider didn't report an exact cost)", color: color.faint }]);
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
