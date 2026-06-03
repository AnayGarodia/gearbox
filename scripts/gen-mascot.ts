// One-off generator: reads the mascot PNG and bakes it into half-block sprites
// that Ink can render with truecolor `color`/`backgroundColor` props (NO raw
// ANSI — that corrupts Ink's width math). Each output character is one terminal
// cell covering two vertical source pixels via the ▀ upper-half-block: the glyph
// is the TOP pixel's color, the background is the BOTTOM pixel's color. The
// PNG's flat background color is treated as transparent so the ghost floats on
// any terminal. We emit two sizes from the SAME art: a big splash sprite and a
// small "perched" sprite (both faithful — the small one is downsampled from the
// PNG, never hand-drawn).
//
// Run:  bun run scripts/gen-mascot.ts <input.png>
// Writes: src/ui/mascot-sprite.ts
import { PNG } from "pngjs";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const DL = `${process.env.HOME}/Downloads`;
// name -> source PNG. `base` is the default periwinkle ghost; the rest are moods
// (color swaps) and expressions (wink/shades/party/flag).
const VARIANTS: Record<string, string> = {
  base: `${DL}/Unicode Character Art Gearbox.png`,
  mint: `${DL}/Ghost Mint.png`,
  pink: `${DL}/Ghost Pink.png`,
  golden: `${DL}/Ghost Golden.png`,
  shades: `${DL}/Ghost Shades.png`,
  wink: `${DL}/Ghost Wink.png`,
  party: `${DL}/Ghost Party.png`,
  flag: `${DL}/Ghost Flag.png`,
};

const hex = (p: { r: number; g: number; b: number }) =>
  "#" + [p.r, p.g, p.b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");

type Cell = { t: string | null; b: string | null };

// Build a sprite at `cols` cells wide from one PNG. Nearest-neighbor center
// sampling keeps the pixel-art edges crisp (box-averaging muddied the
// navy/body boundary). The flat navy field is detected per-image and made
// transparent so the ghost floats on any terminal.
function build(src: string, cols: number): Cell[][] {
  const png = PNG.sync.read(readFileSync(src));
  const { width, height, data } = png;
  const at = (x: number, y: number) => {
    const cx = Math.min(Math.max(Math.round(x), 0), width - 1);
    const cy = Math.min(Math.max(Math.round(y), 0), height - 1);
    const i = (cy * width + cx) * 4;
    return { r: data[i]!, g: data[i + 1]!, b: data[i + 2]!, a: data[i + 3]! };
  };
  const bg = at(2, 2);
  const isBg = (p: { r: number; g: number; b: number; a: number }) => {
    if (p.a < 24) return true;
    return Math.abs(p.r - bg.r) + Math.abs(p.g - bg.g) + Math.abs(p.b - bg.b) < 36;
  };

  const cellW = width / cols;
  const rowsPx = cols; // square on screen: each half-block sub-pixel is ~square
  const cellH = height / rowsPx;
  const rows: Cell[][] = [];
  for (let ry = 0; ry < rowsPx; ry += 2) {
    const row: Cell[] = [];
    for (let cx = 0; cx < cols; cx++) {
      const px = (cx + 0.5) * cellW;
      const top = at(px, (ry + 0.5) * cellH);
      const bot = ry + 1 < rowsPx ? at(px, (ry + 1.5) * cellH) : { ...bg, a: 0 };
      row.push({ t: isBg(top) ? null : hex(top), b: isBg(bot) ? null : hex(bot) });
    }
    rows.push(row);
  }
  // Trim fully-transparent borders so the sprite is tight.
  const rowFull = (r: Cell[]) => r.some((c) => c.t || c.b);
  let t0 = 0, b0 = rows.length;
  while (t0 < b0 && !rowFull(rows[t0]!)) t0++;
  while (b0 > t0 && !rowFull(rows[b0 - 1]!)) b0--;
  const mid = rows.slice(t0, b0);
  let l0 = 0, r0 = cols;
  const colEmpty = (x: number) => mid.every((r) => !r[x]!.t && !r[x]!.b);
  while (l0 < r0 && colEmpty(l0)) l0++;
  while (r0 > l0 && colEmpty(r0 - 1)) r0--;
  return mid.map((r) => r.slice(l0, r0));
}

// Three sizes: big = splash, mini = celebration (keeps the party hat), micro =
// the compact inline/working ghost (small footprint so it never dominates the
// transcript during generation).
const sprites: Record<string, { big: Cell[][]; mini: Cell[][]; micro: Cell[][] }> = {};
for (const [name, src] of Object.entries(VARIANTS)) {
  sprites[name] = { big: build(src, 36), mini: build(src, 12), micro: build(src, 10) };
}

// Also emit a transparent, cropped PNG per variant for the kitty image path
// (terminals that support the kitty graphics protocol render the real PNG crisp
// at any size; everything else uses the half-block sprites above). The flat navy
// field becomes transparent so the ghost floats on the terminal background.
function buildPng(src: string): string {
  const png = PNG.sync.read(readFileSync(src));
  const { width, height, data } = png;
  const bg = { r: data[8 * width + 8]!, g: data[8 * width + 9]!, b: data[8 * width + 10]! };
  const isBg = (i: number) => Math.abs(data[i]! - bg.r) + Math.abs(data[i + 1]! - bg.g) + Math.abs(data[i + 2]! - bg.b) < 36;
  // Knock out the background to transparent and find the content bounding box.
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (isBg(i)) data[i + 3] = 0;
      else {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  const cw = maxX - minX + 1, ch = maxY - minY + 1;
  const out = new PNG({ width: cw, height: ch });
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const si = ((y + minY) * width + (x + minX)) * 4;
      const di = (y * cw + x) * 4;
      out.data[di] = data[si]!;
      out.data[di + 1] = data[si + 1]!;
      out.data[di + 2] = data[si + 2]!;
      out.data[di + 3] = data[si + 3]!;
    }
  }
  return PNG.sync.write(out).toString("base64");
}

const pngs: Record<string, string> = {};
for (const [name, src] of Object.entries(VARIANTS)) pngs[name] = buildPng(src);
writeFileSync(
  resolve(import.meta.dir, "../src/ui/mascot-png.ts"),
  `// AUTO-GENERATED by scripts/gen-mascot.ts — do not edit by hand.\n` +
    `// Base64 PNG (transparent background, cropped) per ghost variant, transmitted\n` +
    `// to kitty-graphics terminals (src/ui/image.ts). Half-block fallback lives in\n` +
    `// mascot-sprite.ts for terminals without image support.\n` +
    `export const GHOST_PNG: Record<string, string> = ${JSON.stringify(pngs)};\n`,
);

const out = `// AUTO-GENERATED by scripts/gen-mascot.ts — do not edit by hand.
// Each cell is one terminal character (▀): \`t\` is the top pixel color, \`b\` the
// bottom. \`null\` = transparent (shows the terminal background). Rendered by
// src/ui/components/Mascot.tsx. big = splash, mini = celebration, micro = inline.
export type SpriteCell = { t: string | null; b: string | null };
export type GhostSprite = { big: SpriteCell[][]; mini: SpriteCell[][]; micro: SpriteCell[][] };
export const GHOSTS: Record<string, GhostSprite> = ${JSON.stringify(sprites)};
// Back-compat aliases (the default ghost).
export const GHOST_SPRITE: SpriteCell[][] = GHOSTS.base!.big;
export const GHOST_MINI: SpriteCell[][] = GHOSTS.base!.micro;
`;
writeFileSync(resolve(import.meta.dir, "../src/ui/mascot-sprite.ts"), out);
console.log(
  Object.entries(sprites)
    .map(([n, s]) => `${n} ${s.big.length}r/${s.mini.length}r/${s.micro.length}r`)
    .join("  ·  "),
);
