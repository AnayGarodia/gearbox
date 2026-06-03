import { test, expect } from "bun:test";
import {
  renderGhost,
  ghostDims,
  overlayPixels,
  FACE_LIST,
  PALETTE_ORDER,
  PERSONA_ORDER,
  type GhostCfg,
} from "../src/ui/ghost/engine.ts";
import { SKINS, skinToCfg, stateView, type MascotState } from "../src/ui/components/Mascot.tsx";

// The blocks path now renders the parametric engine live, so the tests cover the
// pure engine: the half-block FOLD, dimensions, crop, persona padding, overlay
// determinism, and the skin/state cfg mappings.

test("fold pairs vertical pixels: px row0 → cell.t, px row1 → cell.b", () => {
  // happy has a solid body; col 9 is filled top-to-bottom through the torso.
  const cells = renderGhost({ palette: "default", face: "happy" });
  // body starts at px row 4 → cell row 2 (.t = row4, .b = row5), both body color.
  const cell = cells[2]![9]!;
  expect(cell.t).toBe("#e0e7ff");
  expect(cell.b).toBe("#e0e7ff");
  // top of the sprite (px rows 0-1) is empty → transparent.
  expect(cells[0]!.every((c) => c.t === null && c.b === null)).toBe(true);
});

test("dimensions: 1× is 20×10, 2× is 40×20", () => {
  expect(ghostDims({ palette: "default", face: "happy" })).toEqual({ cols: 20, rows: 10 });
  expect(ghostDims({ palette: "default", face: "happy", scale: 2 })).toEqual({ cols: 40, rows: 20 });
});

test("crop slices native-resolution rows (no downsample)", () => {
  // head crop rows 4..14 = 10 px rows → 5 cell rows, width unchanged.
  expect(ghostDims({ palette: "default", face: "thinking", crop: { rowStart: 4, rowEnd: 14 } })).toEqual({ cols: 20, rows: 5 });
  // the hat crop keeps the full 0..14 band → 7 cell rows.
  expect(ghostDims({ palette: "mint", face: "joy", accessory: "party", crop: { rowStart: 0, rowEnd: 14 } })).toEqual({ cols: 20, rows: 7 });
});

test("persona grid pads to an even height (h=21 → 11 cell rows)", () => {
  const cells = renderGhost({ palette: "void", face: "happy", persona: "skater" });
  expect(cells.length).toBe(11); // 22 px rows / 2
  // the padded last px row is transparent → some .b in the final cell row are null.
  expect(cells[10]!.some((c) => c.b === null)).toBe(true);
});

test("overlayPixels is deterministic per frame and relocates load dots when cropped", () => {
  expect(overlayPixels("confetti", 3)).toEqual(overlayPixels("confetti", 3));
  // load dots sit below the feet normally (row 19) but move above the head when cropped.
  const below = overlayPixels("load", 3, false);
  const above = overlayPixels("load", 3, true);
  expect(below.every(([, r]) => r === 19)).toBe(true);
  expect(above.every(([, r]) => r === 2)).toBe(true);
});

test("every face and palette renders without throwing", () => {
  for (const face of FACE_LIST) {
    for (const palette of PALETTE_ORDER) {
      const cells = renderGhost({ palette, face });
      expect(cells.length).toBe(10);
    }
  }
});

test("every persona renders at the padded height", () => {
  for (const persona of PERSONA_ORDER) {
    const cells = renderGhost({ palette: "default", face: "happy", persona });
    expect(cells.length).toBe(11);
  }
});

test("skinToCfg covers every skin and yields a renderable cfg", () => {
  for (const skin of SKINS) {
    const cfg: GhostCfg = skinToCfg(skin);
    expect(cfg.palette).toBeTruthy();
    expect(cfg.face).toBeTruthy();
    expect(renderGhost(cfg).length).toBe(10);
  }
});

test("every mascot state maps to a renderable cropped cfg", () => {
  const states: MascotState[] = ["thinking", "streaming", "tool", "celebrate", "error"];
  for (const s of states) {
    const { cfg } = stateView(s, "base");
    expect(cfg.crop).toBeTruthy();
    const cells = renderGhost(cfg);
    // every line ≤ width invariant (matches the transcript line-buffer rule).
    expect(cells.every((row) => row.length === 20)).toBe(true);
    expect(cells.length).toBeLessThanOrEqual(7);
  }
});
