// The look lives here. Change colors/glyphs in one place, never inline.
// Restraint is the aesthetic: one cool accent (periwinkle — the ghost mascot),
// calm lavender-grays on navy, color used only to mean something
// (running / ok / error). Palette is drawn from the mascot sprite so the whole
// UI and the ghost are one family.

export interface Theme {
  accent: string;
  accentDim: string;
  text: string;
  dim: string;
  faint: string;
  user: string;
  ok: string;
  err: string;
  run: string;
  navy: string;
}

// Built-in palettes. `dark` is the original periwinkle-on-navy look.
export const THEMES: Record<string, Theme> = {
  dark: {
    accent: "#A5B4FC", accentDim: "#6E76B0", text: "#DCE2F7", dim: "#8A91B4", faint: "#565E80",
    user: "#7FB7E8", ok: "#7FD7A8", err: "#F0868C", run: "#A5B4FC", navy: "#1E1B4B",
  },
  light: {
    accent: "#5B53D6", accentDim: "#8A86C9", text: "#1E1B4B", dim: "#4B5168", faint: "#9AA0B8",
    user: "#1D4ED8", ok: "#0F9D58", err: "#C5283D", run: "#5B53D6", navy: "#1E1B4B",
  },
  mono: {
    accent: "#FFFFFF", accentDim: "#9A9A9A", text: "#F4F4F4", dim: "#B0B0B0", faint: "#7A7A7A",
    user: "#FFFFFF", ok: "#7CFC7C", err: "#FF6B6B", run: "#FFFFFF", navy: "#000000",
  },
  solarized: {
    accent: "#268BD2", accentDim: "#5E7A8A", text: "#EEE8D5", dim: "#93A1A1", faint: "#657B83",
    user: "#2AA198", ok: "#859900", err: "#DC322F", run: "#268BD2", navy: "#002B36",
  },
};
export const THEME_NAMES = Object.keys(THEMES);

// `color` is a single mutable object: every component reads its props fresh each
// render, so swapping a theme is `Object.assign(color, THEMES[name])` + a re-render.
export const color: Theme = { ...THEMES.dark! };

/** Swap the active theme in place. Returns false for an unknown name. */
export function setTheme(name: string): boolean {
  const t = THEMES[name];
  if (!t) return false;
  Object.assign(color, t);
  return true;
}

// A considered set, not emoji: a quarter-block spine for your turns, a filled
// circle + result connector for tool calls (status shown by the circle's COLOR,
// not a tick), an angle prompt, a hairline rule. Restraint over decoration.
export const glyph = {
  prompt: "❯", // composer
  userBar: "▎", // the colored spine on your messages
  tool: "⏺", // tool call (color = status)
  result: "⎿", // tool result / continuation
  branch: "⎇", // git branch
  notice: "◆", // notices
  err: "▲", // hard errors
  bullet: "·",
  rule: "─",
  on: "●",
  off: "○",
} as const;
