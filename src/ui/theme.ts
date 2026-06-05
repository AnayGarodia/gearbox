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
  path: string;
  userBg: string;
  codeBg: string;
  panelBg: string;
  accentBg: string;
  codeKeyword: string;
  codeString: string;
  codeNumber: string;
  codeComment: string;
  codePunct: string;
  codeFunction: string;
  codeType: string;
  codeOperator: string;
  codeBracket: string;
  diffAddBg: string;
  diffDelBg: string;
  diffContextBg: string;
}

// Built-in palettes. `dark` is the original periwinkle-on-navy look.
export const THEMES: Record<string, Theme> = {
  dark: {
    accent: "#7DD3FC", accentDim: "#60A5FA", text: "#EEF4FF", dim: "#B4BDD7", faint: "#7F89A8",
    user: "#DCEBFF", ok: "#75F0A3", err: "#FF7A8A", run: "#C084FC", navy: "#161A2D",
    userBg: "#17324A", codeBg: "#151F36", panelBg: "#17223A", accentBg: "#12364B",
    path: "#F0ABFC", codeKeyword: "#7DD3FC", codeString: "#A7F3D0", codeNumber: "#FCA5A5", codeComment: "#7D879F", codePunct: "#CBD5E1",
    codeFunction: "#F472B6", codeType: "#C4B5FD", codeOperator: "#FBBF24", codeBracket: "#22D3EE",
    diffAddBg: "#0B331E", diffDelBg: "#3A1018", diffContextBg: "#151F36",
  },
  light: {
    accent: "#5B53D6", accentDim: "#8A86C9", text: "#1E1B4B", dim: "#4B5168", faint: "#9AA0B8",
    user: "#1D4ED8", ok: "#0F9D58", err: "#C5283D", run: "#5B53D6", navy: "#1E1B4B",
    userBg: "#EAF2FF", codeBg: "#F2F5FB", panelBg: "#EEF0F7", accentBg: "#ECEAFE",
    path: "#6D28D9", codeKeyword: "#6D28D9", codeString: "#15803D", codeNumber: "#2563EB", codeComment: "#8A8FA3", codePunct: "#64748B",
    codeFunction: "#BE185D", codeType: "#7C3AED", codeOperator: "#A16207", codeBracket: "#4F46E5",
    diffAddBg: "#DCFCE7", diffDelBg: "#FEE2E2", diffContextBg: "#F2F5FB",
  },
  mono: {
    accent: "#FFFFFF", accentDim: "#9A9A9A", text: "#F4F4F4", dim: "#B0B0B0", faint: "#7A7A7A",
    user: "#FFFFFF", ok: "#7CFC7C", err: "#FF6B6B", run: "#FFFFFF", navy: "#000000",
    userBg: "#202020", codeBg: "#161616", panelBg: "#242424", accentBg: "#303030",
    path: "#FFFFFF", codeKeyword: "#FFFFFF", codeString: "#D8D8D8", codeNumber: "#C8C8C8", codeComment: "#7A7A7A", codePunct: "#B0B0B0",
    codeFunction: "#FFFFFF", codeType: "#D8D8D8", codeOperator: "#C8C8C8", codeBracket: "#B0B0B0",
    diffAddBg: "#103018", diffDelBg: "#351014", diffContextBg: "#161616",
  },
  solarized: {
    accent: "#268BD2", accentDim: "#5E7A8A", text: "#EEE8D5", dim: "#93A1A1", faint: "#657B83",
    user: "#2AA198", ok: "#859900", err: "#DC322F", run: "#268BD2", navy: "#002B36",
    userBg: "#073642", codeBg: "#00212A", panelBg: "#07313B", accentBg: "#123A46",
    path: "#6C71C4", codeKeyword: "#268BD2", codeString: "#2AA198", codeNumber: "#D33682", codeComment: "#657B83", codePunct: "#93A1A1",
    codeFunction: "#B58900", codeType: "#6C71C4", codeOperator: "#CB4B16", codeBracket: "#859900",
    diffAddBg: "#073B27", diffDelBg: "#3B1518", diffContextBg: "#00212A",
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
