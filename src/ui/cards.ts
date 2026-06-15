// The CARD KIT — one container language for the whole transcript surface.
// Gearbox draws no borders; structure comes from background LAYERS. These pure
// helpers are the single source of that language so every contained thing — a
// diff, a code block, a route card, a panel section — reads as the same kit.
//
// All helpers return Span[]/Line (never raw ANSI) and paint a full-width tinted
// row via padBg, so a "card" is a stack of same-width tinted rows: a brighter
// header bar, then body rows on the surface tint. Width math is display-aware.
import { color, glyph } from "./theme.ts";
import { displayWidth, sliceWidth } from "./width.ts";
import type { Span, Line } from "./lines.ts";

/** Pad a line with a trailing bg run so it fills `width` columns. */
export function fillBg(spans: Span[], width: number, bg: string): Line {
  const len = spans.reduce((n, s) => n + displayWidth(s.text), 0);
  return len < width ? [...spans, { text: " ".repeat(width - len), bg }] : spans;
}

/** Clip spans to width (display-aware), then fill the remainder with `bg`. */
export function bgRow(spans: Span[], width: number, bg: string): Line {
  const clipped: Span[] = [];
  let len = 0;
  for (const s of spans) {
    if (len >= width) break;
    const { text, width: w } = sliceWidth(s.text, width - len);
    if (text) clipped.push({ ...s, text, bg: s.bg ?? bg });
    len += w;
    if (text.length < s.text.length) break;
  }
  return fillBg(clipped, width, bg);
}

/** A pill / badge: ` label ` on the chip tint. The caller supplies the ink; the
 *  surface is the shared chipBg so every pill matches. A leading accent tick
 *  (▏) optionally marks it as the "now"/active pill. */
export function pill(label: string, ink: string, opts: { bg?: string; bold?: boolean; tick?: boolean } = {}): Span[] {
  const bg = opts.bg ?? color.chipBg;
  const out: Span[] = [];
  if (opts.tick) out.push({ text: "▏", color: ink, bg });
  out.push({ text: opts.tick ? `${label} ` : ` ${label} `, color: ink, bg, bold: opts.bold });
  return out;
}

/** Join pills with a one-space gap (transparent), for a row of badges. */
export function pillRow(pills: Span[][]): Span[] {
  const out: Span[] = [];
  pills.forEach((p, i) => { if (i > 0) out.push({ text: " " }); out.push(...p); });
  return out;
}

/** A card HEADER bar: a full-width row on the header tint with a left accent
 *  spine, a bold title, and an optional right-aligned figure (stats/badges). */
export function headerBar(title: Span[], right: Span[], width: number): Line {
  const bg = color.headerBg;
  const leftSpans: Span[] = [{ text: "▏ ", color: color.accent, bg }, ...title.map((s) => ({ ...s, bg: s.bg ?? bg }))];
  const rightW = right.reduce((n, s) => n + displayWidth(s.text), 0);
  const leftW = leftSpans.reduce((n, s) => n + displayWidth(s.text), 0);
  const gap = Math.max(1, width - leftW - rightW);
  return [...leftSpans, { text: " ".repeat(gap), bg }, ...right.map((s) => ({ ...s, bg: s.bg ?? bg }))];
}

/** A hairline divider row tinted to a card surface (used between hunks/sections). */
export function dividerRow(label: string, width: number, bg = color.headerBg): Line {
  const text = label ? ` ${label} ` : "";
  const left = `${glyph.rule.repeat(2)}${text}`;
  const fill = Math.max(0, width - displayWidth(left));
  return [{ text: left, color: color.faint, bg }, { text: glyph.rule.repeat(fill), color: color.faint, bg }];
}
