// Kitty graphics protocol via Unicode placeholders — the one image method that
// composes with Ink's animated layout. The image is transmitted ONCE at startup
// (cached by the terminal under an id); thereafter we only print placeholder
// cells (U+10EEEE) whose foreground color encodes that id and whose combining
// diacritics encode row/column. Ink measures each placeholder as a normal
// width-1 character (diacritics are width-0), so there is NO width corruption —
// unlike raw image escapes, which Ink can't measure (CLAUDE.md warns against
// foreign ANSI). Re-renders just reprint cheap placeholder text; the pixels stay.
//
// Terminals that don't speak kitty fall back to the half-block sprites
// (mascot-sprite.ts). Force either path with GEARBOX_GHOST=kitty|blocks.
import { GHOST_PNG } from "./mascot-png.ts";
import { GHOSTS } from "./mascot-sprite.ts";

// "kitty"  → full crisp PNG (splash + inline) via Unicode placeholders. Only
//            kitty and Ghostty implement placeholders, so only they get inline.
// "iterm"  → crisp PNG splash banner via the iTerm2 OSC 1337 protocol (iTerm2,
//            WezTerm). Printed once above the UI; inline ghost stays half-blocks.
// "blocks" → half-blocks everywhere (Terminal.app and the rest — Terminal.app
//            supports no image protocol at all).
export type ImageMode = "kitty" | "iterm" | "blocks";
export type GhostSize = "big" | "mini" | "micro";
const SIZES: GhostSize[] = ["big", "mini", "micro"];
const VARIANTS = Object.keys(GHOST_PNG);

const PLACEHOLDER = "\u{10eeee}";
// kitty row/column diacritics (kitty/gen/rowcolumn-diacritics.txt). Index N → row
// or column N. We only need up to the tallest sprite (~17 rows); 50 is ample.
const DIACRITICS = [
  0x0305, 0x030d, 0x030e, 0x0310, 0x0312, 0x033d, 0x033e, 0x033f, 0x0346, 0x034a,
  0x034b, 0x034c, 0x0350, 0x0351, 0x0352, 0x0357, 0x035b, 0x0363, 0x0364, 0x0365,
  0x0366, 0x0367, 0x0368, 0x0369, 0x036a, 0x036b, 0x036c, 0x036d, 0x036e, 0x036f,
  0x0483, 0x0484, 0x0485, 0x0486, 0x0487, 0x0592, 0x0593, 0x0594, 0x0595, 0x0597,
  0x0598, 0x0599, 0x059c, 0x059d, 0x059e, 0x059f, 0x05a0, 0x05a1, 0x05a8, 0x05a9,
].map((c) => String.fromCodePoint(c));

export function detectImageMode(): ImageMode {
  // Default to half-blocks — they render correctly on every truecolor terminal.
  // The PNG paths (kitty placeholders / iTerm OSC 1337) are opt-in via
  // GEARBOX_GHOST=kitty|iterm: the kitty placeholder protocol is young and
  // mis-renders in some terminals (Ghostty squished the image), so it's not the
  // safe default. blocks = always-right; kitty/iterm = crisper where they work.
  const force = process.env.GEARBOX_GHOST;
  if (force === "kitty" || force === "iterm") return force;
  return "blocks";
}

// Resolved once at startup (cli.tsx) so the UI and the launcher agree. Falls back
// to env detection when unset (e.g. in tests that render components directly).
let resolved: ImageMode | null = null;
export function setImageMode(m: ImageMode): void {
  resolved = m;
}
export function getImageMode(): ImageMode {
  return resolved ?? detectImageMode();
}

/** Deterministic image id per (variant, size). 1..24, fits in the fg-color low byte. */
export function imageId(variant: string, size: GhostSize): number {
  return VARIANTS.indexOf(variant) * SIZES.length + SIZES.indexOf(size) + 1;
}

/** Hex fg color that encodes the image id in its low 24 bits (kitty reads it back). */
export function idColor(id: number): string {
  const bytes = [(id >> 16) & 0xff, (id >> 8) & 0xff, id & 0xff];
  return "#" + bytes.map((x) => x.toString(16).padStart(2, "0")).join("");
}

function transmitOne(id: number, b64: string, cols: number, rows: number): string {
  const ESC = "\x1b";
  const CHUNK = 4096;
  if (b64.length <= CHUNK) {
    return `${ESC}_Ga=T,U=1,i=${id},c=${cols},r=${rows},f=100,q=2;${b64}${ESC}\\`;
  }
  let out = "";
  for (let i = 0; i < b64.length; i += CHUNK) {
    const chunk = b64.slice(i, i + CHUNK);
    const more = i + CHUNK < b64.length ? 1 : 0;
    out += i === 0
      ? `${ESC}_Ga=T,U=1,i=${id},c=${cols},r=${rows},f=100,q=2,m=${more};${chunk}${ESC}\\`
      : `${ESC}_Gm=${more};${chunk}${ESC}\\`;
  }
  return out;
}

/** Every (variant, size) image, transmitted once. Write to stdout before Ink renders. */
export function transmitAll(): string {
  let out = "";
  for (const variant of VARIANTS) {
    for (const size of SIZES) {
      const data = GHOSTS[variant]![size];
      out += transmitOne(imageId(variant, size), GHOST_PNG[variant]!, data[0]?.length ?? 0, data.length);
    }
  }
  return out;
}

// ── iTerm2 / WezTerm (OSC 1337) ────────────────────────────────────────────
// At-cursor protocol — can't animate inside Ink, but fine printed once as a
// static welcome banner above the live UI (cli.tsx). Inline ghost stays blocks.

/** OSC 1337 inline image, scaled to `widthCells` columns (aspect preserved). */
export function osc1337Image(b64: string, widthCells: number): string {
  const size = Buffer.from(b64, "base64").length;
  return `\x1b]1337;File=inline=1;size=${size};width=${widthCells};preserveAspectRatio=1:${b64}\x07`;
}

/** The base ghost as a centered OSC 1337 banner, sized to match the block splash. */
export function itermSplash(columns: number): string {
  const cols = GHOSTS.base!.big[0]?.length ?? 22;
  const pad = Math.max(0, Math.floor((columns - cols) / 2));
  return "\n" + " ".repeat(pad) + osc1337Image(GHOST_PNG.base!, cols) + "\n\n";
}

/** Placeholder text rows for one cols×rows image; wrap each in <Text color={idColor(id)}>.
 *  Every cell carries BOTH its row and column diacritic explicitly — kitty's
 *  "omit to auto-increment" shortcut is unreliable in young implementations
 *  (Ghostty), which collapsed the image into too few columns. Explicit is safe. */
export function placeholderRows(cols: number, rows: number): string[] {
  const lines: string[] = [];
  for (let r = 0; r < rows; r++) {
    let line = "";
    for (let c = 0; c < cols; c++) line += PLACEHOLDER + DIACRITICS[r]! + DIACRITICS[c]!;
    lines.push(line);
  }
  return lines;
}
