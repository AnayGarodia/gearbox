// ============================================================================
// GHOST MASCOT ENGINE (parametric)
// ----------------------------------------------------------------------------
// Ported from the Claude Design handoff (project/ghost.js). A 20x20 pixel ghost
// built as composable layers: body (palette-driven), face (eyes/mouth),
// accessory, persona, and dynamic overlay (tears, dots, confetti, etc.). The
// browser original painted to <canvas>; here we paint into a color grid and fold
// pairs of vertical pixels into half-block terminal cells: `t` = top pixel
// (rendered as ▀ with color=t), `b` = bottom pixel (backgroundColor / ▄).
// `null` = transparent. This matches the half-block representation gen-mascot.ts
// bakes, so the existing render pipeline (Mascot.tsx SpriteRow) consumes it
// unchanged.
//
// Aspect rule matches gen-mascot.ts exactly: 2 pixel-rows per cell row, 1 pixel
// per column, so pixels stay square on screen.
//
// Pure module — no Ink, no React. Source of truth for the blocks render path.
// ============================================================================

export type SpriteCell = { t: string | null; b: string | null };

type Color = string;
type Role = "B" | "H" | "S" | "L" | "R";
type Key = "d" | "s" | "m" | "d-lit" | string; // string = literal hex
export type Pixel = [number, number, Key];

export interface Palette {
  body: Color;
  hi: Color;
  eyeDark: Color;
  eyeShine: Color;
  mouth: Color;
  sole: Color;
  toeL: Color | null;
  toeR: Color | null;
}

export interface Face {
  label: string;
  eyes: Pixel[];
  mouth: Pixel[];
  extras?: Pixel[];
  accessory?: string;
  cry?: boolean;
  zzz?: boolean;
  dots?: boolean;
}

export interface Accessory {
  pixels: [number, number, Color][];
  hideEyes?: boolean;
}

export interface Persona {
  label: string;
  blurb: string;
  palette: string;
  face: string;
  behind?: [number, number, Color][];
  mask?: [number, number, Color][];
  eyes?: Pixel[];
  over?: [number, number, Color][];
  hideEyes?: boolean;
  hideMouth?: boolean;
}

// ---------- PALETTES (role keys: body, hi, eyeDark, eyeShine, mouth, sole, toeL, toeR) ----------
export const PALETTES: Record<string, Palette> = {
  default: { body: "#e0e7ff", hi: "#f0f4ff", eyeDark: "#1e1b4b", eyeShine: "#818cf8", mouth: "#a5b4fc", sole: "#a5b4fc", toeL: "#818cf8", toeR: null },
  fire: { body: "#fed7aa", hi: "#ffedd5", eyeDark: "#7c2d12", eyeShine: "#fb923c", mouth: "#f97316", sole: "#f97316", toeL: "#ef4444", toeR: "#fde047" },
  ice: { body: "#bae6fd", hi: "#e0f2fe", eyeDark: "#0c4a6e", eyeShine: "#38bdf8", mouth: "#7dd3fc", sole: "#7dd3fc", toeL: "#38bdf8", toeR: "#38bdf8" },
  golden: { body: "#fef08a", hi: "#fff9c4", eyeDark: "#713f12", eyeShine: "#fbbf24", mouth: "#fcd34d", sole: "#fcd34d", toeL: "#fbbf24", toeR: null },
  mint: { body: "#a7f3d0", hi: "#d1fae5", eyeDark: "#064e3b", eyeShine: "#34d399", mouth: "#6ee7b7", sole: "#6ee7b7", toeL: "#34d399", toeR: null },
  pink: { body: "#fbcfe8", hi: "#fde8f3", eyeDark: "#831843", eyeShine: "#f472b6", mouth: "#f9a8d4", sole: "#f9a8d4", toeL: "#f472b6", toeR: null },
  void: { body: "#c4b5fd", hi: "#ede9fe", eyeDark: "#2e1065", eyeShine: "#a78bfa", mouth: "#a78bfa", sole: "#a78bfa", toeL: "#8b5cf6", toeR: null },
  slate: { body: "#cbd5e1", hi: "#f1f5f9", eyeDark: "#1e293b", eyeShine: "#64748b", mouth: "#94a3b8", sole: "#94a3b8", toeL: "#64748b", toeR: null },
  ember: { body: "#fca5a5", hi: "#fee2e2", eyeDark: "#7f1d1d", eyeShine: "#f87171", mouth: "#ef4444", sole: "#ef4444", toeL: "#dc2626", toeR: "#fca5a5" },
};
export const PALETTE_ORDER = ["default", "fire", "ice", "golden", "mint", "pink", "void", "slate", "ember"];

// ---------- BODY SILHOUETTE ----------
// Maps "c,r" to a palette role. Eyes and mouth are absent here; faces overlay them.
function buildBody(): Map<string, Role> {
  const m = new Map<string, Role>();
  const set = (c: number, r: number, role: Role) => m.set(c + "," + r, role);
  const fullRows: Record<number, [number, number]> = {
    4: [6, 13], 5: [5, 14], 6: [4, 15], 7: [4, 15], 8: [4, 15], 9: [4, 15],
    10: [4, 15], 11: [4, 15], 12: [4, 15], 13: [4, 15], 14: [4, 15],
  };
  for (const r in fullRows) {
    const [a, b] = fullRows[+r]!;
    for (let c = a; c <= b; c++) set(c, +r, "B");
  }
  [4, 5, 9, 10, 14, 15].forEach((c) => set(c, 15, "B")); // foot tops in body color
  [4, 5, 9, 10, 14, 15].forEach((c) => set(c, 16, "S")); // sole band
  ([[4, "L"], [5, "R"], [9, "L"], [10, "R"], [14, "L"], [15, "R"]] as [number, Role][]).forEach(([c, role]) => {
    set(c, 17, role);
    set(c, 18, role);
  });
  // Highlight: top crown and upper-left edge give the body a rounded 3D feel.
  ([[6, 4], [7, 4], [8, 4], [4, 6], [4, 7], [4, 8]] as [number, number][]).forEach(([c, r]) => set(c, r, "H"));
  return m;
}
export const BODY = buildBody();

// ---------- FACE PARTS ----------
const mirror = (px: Pixel[]): Pixel[] => px.map(([c, r, k]) => [c + 5, r, k] as Pixel);
const EYE_L: Pixel[] = [[6, 6, "s"], [7, 6, "d"], [8, 6, "d"], [6, 7, "d"], [7, 7, "d"], [8, 7, "d"], [6, 8, "d"], [7, 8, "d"], [8, 8, "d"], [6, 9, "d"], [7, 9, "d"], [8, 9, "d"]];
const EYE_R = mirror(EYE_L);
export const EYES_OPEN = EYE_L.concat(EYE_R);
const CLOSED_L: Pixel[] = [[6, 8, "d"], [7, 8, "d"], [8, 8, "d"]];
export const EYES_CLOSED = CLOSED_L.concat(mirror(CLOSED_L));

const M_FLAT: Pixel[] = [[7, 11, "m"], [8, 11, "m"], [9, 11, "m"], [10, 11, "m"], [11, 11, "m"]];
const M_SMILE: Pixel[] = [[7, 11, "m"], [11, 11, "m"], [8, 12, "m"], [9, 12, "m"], [10, 12, "m"]];
const M_FROWN: Pixel[] = [[8, 11, "m"], [9, 11, "m"], [10, 11, "m"], [7, 12, "m"], [11, 12, "m"]];
const M_O: Pixel[] = [[8, 11, "m"], [9, 11, "m"], [10, 11, "m"], [8, 12, "m"], [9, 12, "m"], [10, 12, "m"]];
const M_SMALL: Pixel[] = [[8, 11, "m"], [9, 11, "m"], [10, 11, "m"]];
const M_OPEN: Pixel[] = [[8, 11, "m"], [9, 11, "m"], [10, 11, "m"], [8, 12, "m"], [10, 12, "m"], [9, 13, "m"]];
const M_GRIN: Pixel[] = [[7, 11, "m"], [8, 11, "m"], [9, 11, "m"], [10, 11, "m"], [11, 11, "m"], [8, 12, "m"], [9, 12, "m"], [10, 12, "m"]];
const M_WAVY: Pixel[] = [[7, 11, "m"], [9, 11, "m"], [11, 11, "m"], [8, 12, "m"], [10, 12, "m"]];
export const M_OPEN_EXPORT = M_OPEN;
export const TALK: Pixel[][] = [M_FLAT, M_SMALL, M_OPEN, M_SMALL];

const RED = "#f43f5e";

// heart shape (3x3) anchored at top-left col/row, literal red
function heart(c: number, r: number): Pixel[] {
  return [[c, r, RED], [c + 2, r, RED], [c, r + 1, RED], [c + 1, r + 1, RED], [c + 2, r + 1, RED], [c + 1, r + 2, RED]];
}

export const FACES: Record<string, Face> = {
  neutral: { label: "Neutral", eyes: EYES_OPEN, mouth: M_FLAT },
  happy: { label: "Happy", eyes: EYES_OPEN, mouth: M_SMILE },
  joy: { label: "Joy", eyes: [[6, 7, "d"], [8, 7, "d"], [7, 6, "d"], [11, 7, "d"], [13, 7, "d"], [12, 6, "d"]], mouth: M_GRIN },
  sad: {
    label: "Sad",
    eyes: ([[6, 7, "s"], [7, 7, "d"], [8, 7, "d"], [6, 8, "d"], [7, 8, "d"], [8, 8, "d"], [6, 9, "d"], [7, 9, "d"], [8, 9, "d"]] as Pixel[])
      .concat([[11, 7, "s"], [12, 7, "d"], [13, 7, "d"], [11, 8, "d"], [12, 8, "d"], [13, 8, "d"], [11, 9, "d"], [12, 9, "d"], [13, 9, "d"]]),
    mouth: M_FROWN,
    extras: [[8, 5, "d-lit"], [11, 5, "d-lit"]],
  },
  angry: {
    label: "Angry",
    eyes: ([[6, 7, "d"], [7, 7, "d"], [8, 8, "d"], [6, 8, "d"], [7, 8, "d"], [8, 7, "d"], [6, 9, "d"], [7, 9, "d"], [8, 9, "d"]] as Pixel[])
      .concat([[11, 8, "d"], [12, 7, "d"], [13, 7, "d"], [12, 8, "d"], [13, 8, "d"], [11, 9, "d"], [12, 9, "d"], [13, 9, "d"]]),
    mouth: [[8, 12, "m"], [9, 12, "m"], [10, 12, "m"]],
    extras: [[6, 5, "d-lit"], [7, 6, "d-lit"], [8, 6, "d-lit"], [13, 5, "d-lit"], [12, 6, "d-lit"], [11, 6, "d-lit"]],
  },
  surprised: {
    label: "Surprised",
    eyes: ([[6, 6, "d"], [7, 6, "d"], [8, 6, "d"], [6, 7, "d"], [7, 7, "d"], [8, 7, "d"], [6, 8, "d"], [7, 8, "d"], [8, 8, "d"]] as Pixel[])
      .concat([[11, 6, "d"], [12, 6, "d"], [13, 6, "d"], [11, 7, "d"], [12, 7, "d"], [13, 7, "d"], [11, 8, "d"], [12, 8, "d"], [13, 8, "d"]]),
    mouth: M_O,
  },
  sleepy: { label: "Sleepy", eyes: [[6, 8, "d"], [7, 8, "d"], [8, 7, "d"], [11, 7, "d"], [12, 8, "d"], [13, 8, "d"]], mouth: M_SMALL, zzz: true },
  love: { label: "In love", eyes: [], mouth: M_SMILE, extras: heart(6, 6).concat(heart(11, 6)) },
  dizzy: { label: "Dizzy", eyes: [[6, 6, "d"], [8, 6, "d"], [7, 7, "d"], [6, 8, "d"], [8, 8, "d"], [11, 6, "d"], [13, 6, "d"], [12, 7, "d"], [11, 8, "d"], [13, 8, "d"]], mouth: M_WAVY },
  thinking: {
    label: "Thinking",
    eyes: [[6, 6, "d"], [7, 6, "d"], [6, 7, "d"], [7, 7, "d"], [11, 6, "d"], [12, 6, "d"], [11, 7, "d"], [12, 7, "d"]],
    mouth: [[9, 11, "m"], [10, 11, "m"]],
    extras: [[11, 5, "d-lit"], [12, 5, "d-lit"]],
    dots: true,
  },
  wink: { label: "Wink", eyes: EYE_L.concat([[11, 8, "d"], [12, 8, "d"], [13, 8, "d"]]), mouth: M_SMILE },
  crying: {
    label: "Crying",
    eyes: [[6, 7, "d"], [7, 7, "d"], [8, 7, "d"], [6, 8, "d"], [7, 8, "d"], [8, 8, "d"], [11, 7, "d"], [12, 7, "d"], [13, 7, "d"], [11, 8, "d"], [12, 8, "d"], [13, 8, "d"]],
    mouth: M_FROWN,
    cry: true,
  },
  cool: { label: "Cool", eyes: EYES_OPEN, mouth: M_SMILE, accessory: "shades" },
};

export const FACE_LIST = ["neutral", "happy", "joy", "sad", "angry", "surprised", "sleepy", "love", "dizzy", "thinking", "wink", "crying", "cool"];

// ---------- ACCESSORIES ----------
export const ACCESSORIES: Record<string, Accessory> = {
  none: { pixels: [] },
  party: {
    pixels: [
      [9, 0, "#fde047"], [10, 0, "#fde047"],
      [7, 1, "#f97316"], [8, 1, "#f97316"], [9, 1, "#f97316"], [10, 1, "#f97316"], [11, 1, "#f97316"],
      [6, 2, "#fde047"], [7, 2, "#fde047"], [8, 2, "#fde047"], [9, 2, "#fde047"], [10, 2, "#fde047"], [11, 2, "#fde047"], [12, 2, "#fde047"], [13, 2, "#fde047"],
      [6, 3, "#fde047"], [7, 3, "#fde047"], [8, 3, "#fde047"], [9, 3, "#fde047"], [10, 3, "#fde047"], [11, 3, "#fde047"], [12, 3, "#fde047"], [13, 3, "#fde047"],
      [6, 4, "#f97316"], [7, 4, "#f97316"], [8, 4, "#f97316"], [9, 4, "#f97316"], [10, 4, "#f97316"], [11, 4, "#f97316"], [12, 4, "#f97316"], [13, 4, "#f97316"],
    ],
  },
  flag: {
    pixels: [
      [16, 4, "#9ca3af"], [16, 5, "#9ca3af"], [16, 6, "#9ca3af"], [16, 7, "#9ca3af"], [16, 8, "#9ca3af"], [16, 9, "#9ca3af"], [16, 10, "#9ca3af"], [16, 11, "#9ca3af"],
      [17, 4, "#ef4444"], [18, 4, "#ef4444"], [19, 4, "#ef4444"],
      [17, 5, "#ef4444"], [18, 5, "#ef4444"], [19, 5, "#ef4444"],
      [17, 6, "#f97316"], [18, 6, "#f97316"], [19, 6, "#f97316"],
      [17, 7, "#f97316"], [18, 7, "#f97316"], [19, 7, "#f97316"],
      [17, 8, "#f97316"], [18, 8, "#f97316"], [19, 8, "#f97316"],
    ],
  },
  shades: {
    pixels: [
      [4, 7, "#475569"], [5, 7, "#94a3b8"], [6, 7, "#1e293b"], [7, 7, "#1e293b"], [8, 7, "#1e293b"],
      [4, 8, "#475569"], [5, 8, "#334155"], [6, 8, "#1e293b"], [7, 8, "#1e293b"], [8, 8, "#1e293b"],
      [9, 7, "#475569"], [10, 7, "#475569"], [9, 8, "#475569"], [10, 8, "#475569"],
      [11, 7, "#94a3b8"], [12, 7, "#1e293b"], [13, 7, "#1e293b"], [14, 7, "#1e293b"], [15, 7, "#475569"],
      [11, 8, "#334155"], [12, 8, "#1e293b"], [13, 8, "#1e293b"], [14, 8, "#1e293b"], [15, 8, "#475569"],
    ],
    hideEyes: true,
  },
  crown: {
    pixels: [
      [6, 2, "#fbbf24"], [9, 1, "#fbbf24"], [10, 1, "#fbbf24"], [13, 2, "#fbbf24"],
      [6, 3, "#fbbf24"], [7, 3, "#fbbf24"], [8, 3, "#f59e0b"], [9, 3, "#fbbf24"], [10, 3, "#fbbf24"], [11, 3, "#f59e0b"], [12, 3, "#fbbf24"], [13, 3, "#fbbf24"],
      [6, 4, "#f59e0b"], [7, 4, "#f59e0b"], [8, 4, "#f59e0b"], [9, 4, "#f59e0b"], [10, 4, "#f59e0b"], [11, 4, "#f59e0b"], [12, 4, "#f59e0b"], [13, 4, "#f59e0b"],
      [8, 4, "#fef08a"], [11, 4, "#fef08a"],
    ],
  },
  headphones: {
    pixels: [
      [6, 3, "#1f2937"], [7, 2, "#1f2937"], [8, 2, "#1f2937"], [9, 2, "#374151"], [10, 2, "#374151"], [11, 2, "#1f2937"], [12, 2, "#1f2937"], [13, 3, "#1f2937"],
      [3, 6, "#374151"], [3, 7, "#374151"], [3, 8, "#374151"], [4, 6, "#4b5563"], [4, 7, "#6b7280"], [4, 8, "#4b5563"],
      [16, 6, "#374151"], [16, 7, "#374151"], [16, 8, "#374151"], [15, 6, "#4b5563"], [15, 7, "#6b7280"], [15, 8, "#4b5563"],
    ],
  },
};
export const ACCESSORY_LIST = ["party", "flag", "shades", "crown", "headphones"];

// ---------- PERSONAS (costumes; ported as data, not yet wired to live states) ----------
export const PERSONAS: Record<string, Persona> = {
  wizard: {
    label: "Wizard", blurb: "pointy hat, big ideas", palette: "void", face: "happy",
    over: [
      [10, 0, "#4338ca"], [9, 1, "#4338ca"], [10, 1, "#4338ca"], [8, 2, "#4338ca"], [9, 2, "#4338ca"], [10, 2, "#4338ca"],
      [8, 3, "#4338ca"], [9, 3, "#fbbf24"], [10, 3, "#4338ca"], [11, 3, "#4338ca"],
      [7, 4, "#4338ca"], [8, 4, "#4338ca"], [9, 4, "#4338ca"], [10, 4, "#4338ca"], [11, 4, "#4338ca"], [12, 4, "#4338ca"],
      [5, 5, "#312e81"], [6, 5, "#312e81"], [7, 5, "#312e81"], [8, 5, "#312e81"], [9, 5, "#312e81"], [10, 5, "#312e81"], [11, 5, "#312e81"], [12, 5, "#312e81"], [13, 5, "#312e81"], [14, 5, "#312e81"],
      [6, 4, "#fde047"],
    ],
  },
  skater: {
    label: "Skater", blurb: "cap on backwards, sk8 or die", palette: "default", face: "joy",
    over: [
      [7, 3, "#ef4444"], [8, 3, "#ef4444"], [9, 3, "#ef4444"], [10, 3, "#ef4444"], [11, 3, "#ef4444"], [12, 3, "#ef4444"],
      [6, 4, "#ef4444"], [7, 4, "#ef4444"], [8, 4, "#ef4444"], [9, 4, "#ef4444"], [10, 4, "#ef4444"], [11, 4, "#ef4444"], [12, 4, "#ef4444"], [13, 4, "#ef4444"],
      [9, 3, "#fde047"], [10, 3, "#fde047"],
      [4, 5, "#dc2626"], [3, 5, "#dc2626"],
      [3, 19, "#fb923c"], [4, 19, "#f97316"], [5, 19, "#f97316"], [6, 19, "#f97316"], [7, 19, "#f97316"], [8, 19, "#f97316"], [9, 19, "#f97316"], [10, 19, "#f97316"], [11, 19, "#f97316"], [12, 19, "#f97316"], [13, 19, "#f97316"], [14, 19, "#f97316"], [15, 19, "#f97316"], [16, 19, "#fb923c"],
      [5, 20, "#facc15"], [6, 20, "#facc15"], [13, 20, "#facc15"], [14, 20, "#facc15"],
    ],
  },
  ninja: {
    label: "Ninja", blurb: "silent but cuddly", palette: "slate", face: "angry",
    over: [
      [4, 5, "#1f2937"], [5, 5, "#1f2937"], [6, 5, "#1f2937"], [7, 5, "#1f2937"], [8, 5, "#ef4444"], [9, 5, "#ef4444"], [10, 5, "#ef4444"], [11, 5, "#1f2937"], [12, 5, "#1f2937"], [13, 5, "#1f2937"], [14, 5, "#1f2937"], [15, 5, "#1f2937"],
      [16, 5, "#ef4444"], [17, 5, "#b91c1c"], [16, 6, "#b91c1c"], [18, 6, "#b91c1c"],
      [4, 10, "#1f2937"], [5, 10, "#1f2937"], [6, 10, "#1f2937"], [7, 10, "#1f2937"], [8, 10, "#1f2937"], [9, 10, "#1f2937"], [10, 10, "#1f2937"], [11, 10, "#1f2937"], [12, 10, "#1f2937"], [13, 10, "#1f2937"], [14, 10, "#1f2937"], [15, 10, "#1f2937"],
      [4, 11, "#111827"], [5, 11, "#1f2937"], [6, 11, "#1f2937"], [7, 11, "#1f2937"], [8, 11, "#1f2937"], [9, 11, "#1f2937"], [10, 11, "#1f2937"], [11, 11, "#1f2937"], [12, 11, "#1f2937"], [13, 11, "#1f2937"], [14, 11, "#1f2937"], [15, 11, "#111827"],
    ],
  },
  chef: {
    label: "Chef", blurb: "whipping up something good", palette: "default", face: "happy",
    over: [
      [7, 0, "#f9fafb"], [8, 0, "#f9fafb"], [10, 0, "#f9fafb"], [11, 0, "#f9fafb"],
      [6, 1, "#f9fafb"], [7, 1, "#f9fafb"], [8, 1, "#f9fafb"], [9, 1, "#f9fafb"], [10, 1, "#f9fafb"], [11, 1, "#f9fafb"], [12, 1, "#f9fafb"], [13, 1, "#f9fafb"],
      [6, 2, "#f9fafb"], [7, 2, "#f9fafb"], [8, 2, "#e5e7eb"], [9, 2, "#f9fafb"], [10, 2, "#f9fafb"], [11, 2, "#e5e7eb"], [12, 2, "#f9fafb"], [13, 2, "#f9fafb"],
      [6, 3, "#e5e7eb"], [7, 3, "#f9fafb"], [8, 3, "#f9fafb"], [9, 3, "#f9fafb"], [10, 3, "#f9fafb"], [11, 3, "#f9fafb"], [12, 3, "#f9fafb"], [13, 3, "#e5e7eb"],
      [6, 4, "#f3f4f6"], [7, 4, "#f3f4f6"], [8, 4, "#f3f4f6"], [9, 4, "#f3f4f6"], [10, 4, "#f3f4f6"], [11, 4, "#f3f4f6"], [12, 4, "#f3f4f6"], [13, 4, "#f3f4f6"],
    ],
  },
  pirate: {
    label: "Pirate", blurb: "arr, but make it adorable", palette: "default", face: "happy",
    over: [
      [6, 4, "#b91c1c"], [7, 4, "#ef4444"], [8, 4, "#b91c1c"], [9, 4, "#b91c1c"], [10, 4, "#ef4444"], [11, 4, "#b91c1c"], [12, 4, "#b91c1c"], [13, 4, "#b91c1c"],
      [5, 5, "#b91c1c"], [6, 5, "#b91c1c"], [7, 5, "#b91c1c"], [8, 5, "#b91c1c"], [9, 5, "#b91c1c"], [10, 5, "#b91c1c"], [11, 5, "#b91c1c"], [12, 5, "#b91c1c"], [13, 5, "#b91c1c"], [14, 5, "#b91c1c"],
      [16, 6, "#b91c1c"], [17, 6, "#b91c1c"], [16, 7, "#991b1b"], [17, 8, "#b91c1c"],
      [6, 6, "#111827"], [7, 6, "#111827"], [8, 6, "#111827"], [6, 7, "#111827"], [7, 7, "#111827"], [8, 7, "#111827"], [6, 8, "#111827"], [7, 8, "#111827"], [8, 8, "#111827"],
      [5, 6, "#1f2937"], [9, 5, "#1f2937"],
    ],
  },
  astronaut: {
    label: "Astronaut", blurb: "to the moon, tiny friend", palette: "ice", face: "surprised",
    over: [
      [6, 3, "#bae6fd"], [7, 3, "#f0f9ff"], [8, 3, "#bae6fd"], [9, 3, "#bae6fd"], [10, 3, "#bae6fd"], [11, 3, "#bae6fd"], [12, 3, "#bae6fd"], [13, 3, "#bae6fd"],
      [5, 4, "#bae6fd"], [14, 4, "#bae6fd"], [4, 5, "#bae6fd"], [15, 5, "#bae6fd"],
      [3, 6, "#bae6fd"], [16, 6, "#bae6fd"], [3, 7, "#bae6fd"], [16, 7, "#bae6fd"], [3, 8, "#bae6fd"], [16, 8, "#bae6fd"],
      [4, 9, "#bae6fd"], [15, 9, "#bae6fd"],
      [4, 2, "#94a3b8"], [4, 1, "#ef4444"],
    ],
  },
  graduate: {
    label: "Graduate", blurb: "certified good boy", palette: "default", face: "joy",
    over: [
      [4, 3, "#1e293b"], [5, 3, "#1e293b"], [6, 3, "#1e293b"], [7, 3, "#1e293b"], [8, 3, "#1e293b"], [9, 3, "#1e293b"], [10, 3, "#1e293b"], [11, 3, "#1e293b"], [12, 3, "#1e293b"], [13, 3, "#1e293b"], [14, 3, "#1e293b"], [15, 3, "#1e293b"],
      [7, 4, "#334155"], [8, 4, "#334155"], [9, 4, "#334155"], [10, 4, "#334155"], [11, 4, "#334155"], [12, 4, "#334155"],
      [9, 2, "#fbbf24"], [10, 2, "#fbbf24"], [14, 3, "#fbbf24"], [14, 4, "#fbbf24"], [14, 5, "#fde047"],
    ],
  },
  superhero: {
    label: "Superhero", blurb: "here to save your day", palette: "default", face: "happy",
    behind: [
      [3, 7, "#dc2626"], [3, 8, "#dc2626"], [3, 9, "#dc2626"], [3, 10, "#dc2626"], [2, 11, "#b91c1c"], [3, 11, "#dc2626"], [3, 12, "#dc2626"], [3, 13, "#dc2626"],
      [16, 7, "#dc2626"], [16, 8, "#dc2626"], [16, 9, "#dc2626"], [16, 10, "#dc2626"], [16, 11, "#dc2626"], [17, 11, "#b91c1c"], [16, 12, "#dc2626"], [16, 13, "#dc2626"],
    ],
    mask: [
      [5, 6, "#1d4ed8"], [6, 6, "#1d4ed8"], [7, 6, "#1d4ed8"], [8, 6, "#1d4ed8"], [9, 6, "#1d4ed8"], [10, 6, "#1d4ed8"], [11, 6, "#1d4ed8"], [12, 6, "#1d4ed8"], [13, 6, "#1d4ed8"], [14, 6, "#1d4ed8"],
      [5, 7, "#1d4ed8"], [6, 7, "#1d4ed8"], [7, 7, "#1d4ed8"], [8, 7, "#1d4ed8"], [9, 7, "#1e40af"], [10, 7, "#1e40af"], [11, 7, "#1d4ed8"], [12, 7, "#1d4ed8"], [13, 7, "#1d4ed8"], [14, 7, "#1d4ed8"],
    ],
  },
  cowboy: {
    label: "Cowboy", blurb: "howdy, partner", palette: "golden", face: "happy",
    over: [
      [7, 2, "#92400e"], [8, 2, "#92400e"], [9, 2, "#92400e"], [10, 2, "#92400e"], [11, 2, "#92400e"], [12, 2, "#92400e"],
      [7, 3, "#b45309"], [8, 3, "#fbbf24"], [9, 3, "#fbbf24"], [10, 3, "#fbbf24"], [11, 3, "#fbbf24"], [12, 3, "#b45309"],
      [3, 4, "#92400e"], [4, 4, "#78350f"], [5, 4, "#92400e"], [6, 4, "#92400e"], [7, 4, "#92400e"], [8, 4, "#92400e"], [9, 4, "#92400e"], [10, 4, "#92400e"], [11, 4, "#92400e"], [12, 4, "#92400e"], [13, 4, "#92400e"], [14, 4, "#78350f"], [15, 4, "#92400e"],
    ],
  },
};
export const PERSONA_ORDER = ["wizard", "skater", "ninja", "chef", "pirate", "astronaut", "graduate", "superhero", "cowboy"];

// ---------- OVERLAYS (dynamic bits, frame-driven) ----------
// CSS motion from the gallery, quantized to 1-px integer steps. When a crop is
// active (the compact inline ghost), dots outside the head/feet area are
// relocated into the visible band so the emotional state still reads.
export type OverlayKind = "tears" | "dots" | "load" | "zzz" | "sparkle" | "confetti" | "hearts";

const SPARK_SPOTS: [number, number][] = [[2, 3], [16, 4], [3, 11], [17, 11], [15, 1]];
const CONF_COLS = ["#f43f5e", "#fde047", "#22c55e", "#38bdf8", "#a855f7", "#fb923c"];
const CONF_SPOTS: [number, number][] = [[2, 2], [17, 3], [3, 9], [17, 9], [16, 1], [4, 1], [1, 12], [18, 13], [15, 12]];

export function overlayPixels(kind: OverlayKind, frame: number, cropActive = false): [number, number, Color][] {
  switch (kind) {
    case "tears": {
      // One tear under each eye, rows 9..13, staggered so they fall at different rates.
      const a = 9 + (frame % 5);
      const b = 9 + ((frame + 2) % 5);
      return [[7, a, "#38bdf8"], [12, b, "#38bdf8"]];
    }
    case "dots": {
      // Thinking dots at cols 8/10/12, row 1 or 2; one hops up per frame.
      return [0, 1, 2].map((i) => [8 + 2 * i, (frame - i) % 3 === 0 ? 1 : 2, "#a5b4fc"] as [number, number, Color]);
    }
    case "load": {
      // Sequential fill: above the head when cropped, below the feet otherwise.
      const row = cropActive ? 2 : 19;
      return [0, 1, 2].filter((i) => frame % 4 > i).map((i) => [8 + 2 * i, row, "#38bdf8"] as [number, number, Color]);
    }
    case "zzz": {
      // A single Z pixel climbing and drifting right in the top-right corner.
      const r = 4 - (frame % 5);
      const c = 16 + (frame % 3);
      return [[c, r, "#a5b4fc"]];
    }
    case "sparkle": {
      return SPARK_SPOTS.filter((_, i) => (frame + i) % 2 === 0).map(([c, r], i) => [c, r, i % 2 ? "#fde047" : "#a5b4fc"] as [number, number, Color]);
    }
    case "confetti": {
      return CONF_SPOTS.map(([c, r], i) => [c, (r + frame) % 15, CONF_COLS[i % CONF_COLS.length]!] as [number, number, Color]);
    }
    case "hearts": {
      return heart(3, 5 - (frame % 6)).concat(heart(15, 4 - ((frame + 3) % 6))).map(([c, r]) => [c, r, RED] as [number, number, Color]);
    }
  }
}

// ---------- RENDER ----------
function resolve(key: Key, pal: Palette): Color | null {
  if (typeof key === "string" && key[0] === "#") return key;
  switch (key) {
    case "B": return pal.body;
    case "H": return pal.hi;
    case "S": return pal.sole;
    case "L": return pal.toeL;
    case "R": return pal.toeR;
    case "d": return pal.eyeDark;
    case "s": return pal.eyeShine;
    case "m": return pal.mouth;
    case "d-lit": return pal.eyeDark;
    default: return null;
  }
}

export interface GhostCfg {
  palette: string;
  face: string;
  accessory?: string | null;
  persona?: string | null;
  drip?: boolean;
  eyesOverride?: Pixel[] | null;
  mouthOverride?: Pixel[] | null;
  overlay?: { kind: OverlayKind; frame: number } | null;
  scale?: 1 | 2;
  crop?: { rowStart: number; rowEnd: number } | null;
  hideBehind?: boolean;
  hideOver?: boolean;
}

/** Paint the layered sprite into an H×20 color grid. H = 22 for personas (extra rows for tall costumes), else 20. */
function compositeGrid(cfg: GhostCfg): (Color | null)[][] {
  const pal = PALETTES[cfg.palette] || PALETTES.default!;
  const face = FACES[cfg.face] || FACES.neutral!;
  const accName = cfg.accessory ?? face.accessory ?? "none";
  const acc = ACCESSORIES[accName] || ACCESSORIES.none!;
  const per = cfg.persona ? PERSONAS[cfg.persona] ?? null : null;
  const H = per ? 22 : 20;
  const W = 20;
  const grid: (Color | null)[][] = Array.from({ length: H }, () => Array<Color | null>(W).fill(null));
  const px = (c: number, r: number, col: Color | null) => {
    if (!col || r < 0 || r >= H || c < 0 || c >= W) return;
    grid[r]![c] = col;
  };

  if (per?.behind && !cfg.hideBehind) per.behind.forEach(([c, r, col]) => px(c, r, col));

  BODY.forEach((role, key) => {
    const [c, r] = key.split(",").map(Number) as [number, number];
    px(c, r, resolve(role, pal));
  });

  if (cfg.drip) {
    const cols: [number, Color, Color][] = [[4, "#ef4444", "#f97316"], [5, "#f97316", "#fde047"], [9, "#fde047", "#22c55e"], [10, "#22c55e", "#3b82f6"], [14, "#3b82f6", "#a855f7"], [15, "#a855f7", "#ec4899"]];
    cols.forEach(([c, a, b]) => { px(c, 15, a); px(c, 16, a); px(c, 17, b); px(c, 18, b); });
  }

  if (per?.mask) per.mask.forEach(([c, r, col]) => px(c, r, col));

  const hideEyes = acc.hideEyes || per?.hideEyes;
  const eyes = cfg.eyesOverride || per?.eyes || face.eyes;
  if (!hideEyes) eyes.forEach(([c, r, k]) => px(c, r, resolve(k, pal)));
  if (face.extras && !hideEyes && !cfg.eyesOverride) face.extras.forEach(([c, r, k]) => px(c, r, resolve(k, pal)));

  if (!per?.hideMouth) {
    const mouth = cfg.mouthOverride || face.mouth;
    mouth.forEach(([c, r, k]) => px(c, r, resolve(k, pal)));
  }

  acc.pixels.forEach(([c, r, col]) => px(c, r, col));
  if (per?.over && !cfg.hideOver) per.over.forEach(([c, r, col]) => px(c, r, col));

  if (cfg.overlay) {
    const cropActive = !!cfg.crop;
    overlayPixels(cfg.overlay.kind, cfg.overlay.frame, cropActive).forEach(([c, r, col]) => px(c, r, col));
  }

  return grid;
}

function upscale(grid: (Color | null)[][], n: number): (Color | null)[][] {
  const out: (Color | null)[][] = [];
  for (const row of grid) {
    const big: (Color | null)[] = [];
    for (const v of row) for (let i = 0; i < n; i++) big.push(v);
    for (let i = 0; i < n; i++) out.push(big.slice());
  }
  return out;
}

/** Fold a color grid (even or odd height) into half-block cells: rows (2k, 2k+1). */
function foldToCells(grid: (Color | null)[][]): SpriteCell[][] {
  const cells: SpriteCell[][] = [];
  const W = grid[0]?.length ?? 0;
  for (let r = 0; r < grid.length; r += 2) {
    const top = grid[r]!;
    const bot = grid[r + 1];
    const row: SpriteCell[] = [];
    for (let c = 0; c < W; c++) row.push({ t: top[c] ?? null, b: bot ? bot[c] ?? null : null });
    cells.push(row);
  }
  return cells;
}

/** Render a ghost cfg to half-block cells. Pure, memoized by JSON-stringified cfg. */
const cache = new Map<string, SpriteCell[][]>();
export function renderGhost(cfg: GhostCfg): SpriteCell[][] {
  const memo = cache.get(JSON.stringify(cfg));
  if (memo) return memo;
  let grid = compositeGrid(cfg);
  if (cfg.crop) grid = grid.slice(cfg.crop.rowStart, cfg.crop.rowEnd);
  if (cfg.scale === 2) grid = upscale(grid, 2);
  const cells = foldToCells(grid);
  cache.set(JSON.stringify(cfg), cells);
  return cells;
}

/** Cell dimensions a cfg renders to (for image.ts placeholder math). */
export function ghostDims(cfg: GhostCfg): { cols: number; rows: number } {
  const data = renderGhost(cfg);
  return { cols: data[0]?.length ?? 0, rows: data.length };
}
