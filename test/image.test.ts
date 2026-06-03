import { test, expect, afterEach } from "bun:test";
import { detectImageMode, imageId, idColor, placeholderRows, osc1337Image } from "../src/ui/image.ts";

const PLACEHOLDER = "\u{10eeee}";

afterEach(() => {
  delete process.env.GEARBOX_GHOST;
});

test("GEARBOX_GHOST forces the mode regardless of terminal", () => {
  process.env.GEARBOX_GHOST = "blocks";
  expect(detectImageMode()).toBe("blocks");
  process.env.GEARBOX_GHOST = "kitty";
  expect(detectImageMode()).toBe("kitty");
  process.env.GEARBOX_GHOST = "iterm";
  expect(detectImageMode()).toBe("iterm");
});

test("osc1337Image wraps base64 in a sized inline-image escape", () => {
  const esc = osc1337Image("AAAA", 22);
  expect(esc.startsWith("\x1b]1337;File=inline=1;")).toBe(true);
  expect(esc).toContain("width=22");
  expect(esc).toContain("preserveAspectRatio=1");
  expect(esc.endsWith(":AAAA\x07")).toBe(true);
});

test("image ids are unique per (variant, size)", () => {
  const ids = new Set<number>();
  for (const v of ["base", "mint", "pink", "golden", "shades", "wink", "party", "flag"]) {
    for (const s of ["big", "mini", "micro"] as const) {
      const id = imageId(v, s);
      expect(id).toBeGreaterThan(0);
      expect(ids.has(id)).toBe(false);
      ids.add(id);
    }
  }
});

test("idColor encodes the id in the low 24 bits", () => {
  expect(idColor(1)).toBe("#000001");
  expect(idColor(255)).toBe("#0000ff");
  expect(idColor(258)).toBe("#000102");
});

test("placeholderRows yields one line per row, each measuring `cols` placeholder cells", () => {
  const lines = placeholderRows(8, 5);
  expect(lines.length).toBe(5);
  for (const l of lines) {
    expect([...l].filter((ch) => ch === PLACEHOLDER).length).toBe(8);
  }
  // first cell of a row carries diacritics (row + column); the rest are bare
  expect(lines[0]!.length).toBeGreaterThan(8); // includes combining marks
});
