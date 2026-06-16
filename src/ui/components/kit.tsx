import React from "react";
import { Text } from "ink";
import { color } from "../theme.ts";

// The JSX half of the card kit (the Span-based half is src/ui/cards.ts). One
// pill/badge component so the status bar, usage strip, composer badge, and any
// chrome read as the same designed kit. A pill is ` label ` on the chip tint
// with colored ink — no drawn border, structure from the background layer.
export function Pill({
  label,
  ink = color.text,
  bg = color.chipBg,
  bold = true,
  tick,
}: {
  label: string;
  ink?: string;
  bg?: string;
  bold?: boolean;
  tick?: boolean; // a leading accent spine — marks the "now"/active pill
}) {
  return (
    <Text backgroundColor={bg}>
      {tick ? <Text color={ink}>▏</Text> : <Text>{" "}</Text>}
      <Text color={ink} bold={bold}>{label}</Text>
      <Text>{" "}</Text>
    </Text>
  );
}

// Width a Pill occupies, so callers that budget/measure a row (status bar) can
// account for it without rendering. Mirrors the render: tick/space + label + space.
export const pillWidth = (label: string): number => label.length + 2;

// A decision BUTTON (Quiet Workshop): a single-key chip + its label, e.g.
// ` ⏺ `→` Allow`. The key sits on a solid tone chip (navy ink) so it reads as
// the press; the label is plain text. Used in the rounded decision cards
// (permission / ask / plan) — the one place the UI shows buttons. Both a click
// target and a keyboard shortcut.
export function Button({ hotkey, label, tone = color.accent }: { hotkey: string; label: string; tone?: string }) {
  return (
    <Text>
      <Text backgroundColor={tone} color={color.navy} bold>{` ${hotkey} `}</Text>
      <Text color={color.text}>{` ${label}`}</Text>
    </Text>
  );
}
