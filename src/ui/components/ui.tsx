import React from "react";
import { Text } from "ink";
import { color, glyph } from "../theme.ts";
import { truncate } from "../panel.ts";

// Shared row/field primitives (Broadsheet phase D). Every selectable list in the
// app — palettes, panels, galleries — renders through ListRow so the selection
// language is ONE language: ▶ + accentBg marks the selected row, columns are
// padded with ONE truncation helper, hints render through HintLine (keys accent,
// labels dim) and form fields through Field (◆ errors, aligned margins).

/** THE truncation+padding helper for row columns: clip with … then pad to w. */
export const fitCol = (s: string, w: number): string => truncate(s, w).padEnd(w);

export function ListRow({
  selected,
  label,
  labelWidth,
  labelColor,
  bold,
  detail,
  detailColor,
  marker,
  width,
  children,
}: {
  selected: boolean;
  label: string;
  /** Pad/truncate the label into a fixed column. */
  labelWidth?: number;
  labelColor?: string;
  /** Default: bold when selected. */
  bold?: boolean;
  /** Dim trailing column (string form; use children for styled segments). */
  detail?: string;
  detailColor?: string;
  /** A small glyph between the selection marker and the label (e.g. a pin ●). */
  marker?: { text: string; color?: string };
  /** When set (and detail is plain), pad the row to this width so the selection
   *  background covers the full row. */
  width?: number;
  children?: React.ReactNode;
}) {
  const labelText = labelWidth ? fitCol(label, labelWidth) : label;
  let detailText = detail != null ? "  " + detail : "";
  let pad = "";
  if (width != null && !children) {
    const used = 2 + (marker?.text.length ?? 0) + labelText.length;
    if (used + detailText.length > width) detailText = truncate(detailText, Math.max(0, width - used));
    pad = " ".repeat(Math.max(0, width - used - detailText.length));
  }
  return (
    <Text wrap="truncate-end" backgroundColor={selected ? color.accentBg : undefined}>
      <Text color={selected ? color.accent : color.faint}>{selected ? `${glyph.select} ` : "  "}</Text>
      {marker ? <Text color={marker.color ?? color.faint}>{marker.text}</Text> : null}
      <Text color={labelColor ?? color.text} bold={bold ?? selected}>{labelText}</Text>
      {detailText ? <Text color={detailColor ?? color.faint}>{detailText}</Text> : null}
      {children}
      {pad ? <Text>{pad}</Text> : null}
    </Text>
  );
}

// "↑↓ move · ⏎ select · esc close" → segments; the leading token of each segment
// is the KEY (accent), the rest is the label (dim). A segment with a leading
// `word:` (e.g. "filter: az") stays all-dim — it's status, not a key.
export function hintSegments(text: string): { key: string; label: string }[] {
  return text
    .split(/\s+·\s+/)
    .filter(Boolean)
    .map((seg) => {
      const m = /^(\S+)\s+(.*)$/.exec(seg.trim());
      if (!m) return { key: seg.trim(), label: "" };
      if (m[1]!.endsWith(":")) return { key: "", label: seg.trim() };
      return { key: m[1]!, label: m[2]! };
    });
}

/** The dim `key action · key action` footer line — keys accent, labels dim. */
export function HintLine({ text }: { text: string }) {
  const segs = hintSegments(text);
  return (
    <Text wrap="truncate-end">
      {segs.map((s, i) => (
        <React.Fragment key={i}>
          {i > 0 ? <Text color={color.faint}> · </Text> : null}
          {s.key ? <Text color={color.accentDim}>{s.key}</Text> : null}
          {s.label ? <Text color={color.faint}>{(s.key ? " " : "") + s.label}</Text> : null}
        </React.Fragment>
      ))}
    </Text>
  );
}

/** Wizard form row: label, value (caret window pre-split by the caller via
 *  fieldWindow), placeholder, and an inline error set in ◆ err ink — every
 *  sub-row shares the same 2-col alignment under the ❯ prompt. */
export function Field({
  label,
  note,
  value,
  placeholder,
  error,
}: {
  label: string;
  /** A dim annotation after the label (e.g. "(visible as typed)"). */
  note?: string;
  /** Caret-windowed value from fieldWindow(): pre + at (inverse) + post. */
  value: { pre: string; at: string; post: string };
  /** Shown dim under the input while the value is empty. */
  placeholder?: string;
  error?: string | null;
}) {
  const empty = !value.pre && !value.post && value.at === " ";
  return (
    <>
      <Text>
        <Text color={color.accent} bold>{label}</Text>
        {note ? <Text color={color.faint}>  {note}</Text> : null}
      </Text>
      <Text>
        <Text color={color.faint}>{glyph.prompt} </Text>
        <Text color={color.text}>{value.pre}</Text>
        <Text color={color.accent} inverse>{value.at}</Text>
        <Text color={color.text}>{value.post}</Text>
      </Text>
      {empty && placeholder ? <Text color={color.faint}>{"  e.g. " + placeholder}</Text> : null}
      {error ? (
        <Text>
          <Text color={color.err}>{"  " + glyph.notice + " "}</Text>
          <Text color={color.err}>{error}</Text>
        </Text>
      ) : null}
    </>
  );
}
