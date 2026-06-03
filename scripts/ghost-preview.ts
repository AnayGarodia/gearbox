// Preview Boo as your terminal will actually render him — now driven by the
// parametric engine (src/ui/ghost/engine.ts), the same source the app uses on
// the default blocks path. Shows the splash, the full expression set, and the
// six in-flow state crops (the legibility check for the compact working ghost).
//
//   bun run scripts/ghost-preview.ts
//   GEARBOX_GHOST=kitty bun run scripts/ghost-preview.ts   (also show the PNG path)
import { renderGhost, FACE_LIST, type SpriteCell, type GhostCfg } from "../src/ui/ghost/engine.ts";
import { stateView, type MascotState } from "../src/ui/components/Mascot.tsx";
import { detectImageMode } from "../src/ui/image.ts";

const hexRgb = (h: string) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const fg = (h: string) => `\x1b[38;2;${hexRgb(h).join(";")}m`;
const bg = (h: string) => `\x1b[48;2;${hexRgb(h).join(";")}m`;
const RESET = "\x1b[0m";

// SpriteCell[][] → ANSI half-block lines (raw ANSI is fine here — standalone
// script, not Ink). ▀ = top pixel as fg, bottom pixel as bg.
function toLines(cells: SpriteCell[][], pad = "  "): string[] {
  return cells.map((row) => {
    let line = pad;
    for (const { t, b } of row) {
      if (t && b) line += fg(t) + bg(b) + "▀" + RESET;
      else if (t) line += fg(t) + "▀" + RESET;
      else if (b) line += fg(b) + "▄" + RESET;
      else line += " ";
    }
    return line;
  });
}

function show(cfg: GhostCfg) {
  for (const l of toLines(renderGhost(cfg))) process.stdout.write(l + "\n");
}

const mode = detectImageMode();
const term = `${process.env.TERM_PROGRAM ?? process.env.TERM ?? "?"}`;
console.log(`\n  terminal: ${term}   image mode: ${mode}   (GEARBOX_NO_MOTION freezes motion in-app)\n`);

console.log("  splash (2×):");
show({ palette: "default", face: "happy", scale: 2 });

console.log("\n  expressions (1×):");
for (const face of FACE_LIST) {
  process.stdout.write(`  ${face}\n`);
  show({ palette: "default", face });
  process.stdout.write("\n");
}

console.log("  in-flow state ghosts (the compact working indicator — check legibility):");
const states: MascotState[] = ["thinking", "streaming", "tool", "celebrate", "error"];
for (const s of states) {
  const { cfg, anim } = stateView(s, "base");
  // sample a representative frame for any frame-driven overlay
  const frameCfg: GhostCfg = { ...cfg };
  if (anim.overlay) frameCfg.overlay = { kind: anim.overlay, frame: 1 };
  process.stdout.write(`\n  ${s}:\n`);
  show(frameCfg);
}

console.log("\n  If a face reads clearly here, it'll read in the app. blocks is the default path.\n");
