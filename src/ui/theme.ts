// The look lives here. Change colors/glyphs in one place, never inline.
// Restraint is the aesthetic: one warm accent (peach), structure from layered
// background shades (terminal canvas → panelBg → elementBg) instead of drawn
// boxes, color only used to mean something (running / ok / error).
//
// Color discipline — each hue means ONE thing, so a glance decodes the screen:
//   accent  = interactive / now — the live composer, the active tab, a clickable
//             command. NEVER static prose, a filename, or a severity level (that
//             dilution is exactly what made the UI read as undifferentiated cyan).
//   ok      = healthy / passed / signed in.   warn = attention, not broken
//             (near-limit, expired, a surprising route).   err = broken / at-limit.
//   path    = code references (filenames, inline code, symbol names) — a calm blue,
//             a step below accent.   user = your text + product names.
//   money is neutral `text` (faint when zero), never `ok` — spend isn't "good".

export interface Theme {
  accent: string;
  accentDim: string;
  text: string;
  dim: string;
  faint: string;
  user: string;
  ok: string;
  warn: string;
  err: string;
  run: string;
  shell: string;
  navy: string;
  path: string;
  userBg: string;
  codeBg: string;
  panelBg: string;
  elementBg: string; // input/chips/modal elements — one layer above panelBg
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

// Warm peach on layered charcoal (the opencode-derived language): grouping comes
// from three background layers (terminal canvas → panelBg → elementBg), not from
// drawn boxes; the single warm accent reads as "now" against the neutral grays.
export const dark: Theme = {
  accent: "#FAB283", accentDim: "#C98A5E", text: "#EEEEEE", dim: "#9A9FA8", faint: "#6B7077",
  // `warn` is the ONLY amber in the semantic vocabulary — spent sparingly on a
  // surprising routing decision, a balance running low, or a key needing
  // attention. Same hue as the code-number amber, kept distinct from `err` (red
  // = something went wrong) so amber can mean "look, but nothing is broken".
  // `user` is the blue spine on your messages — the one cool hue, so your turns
  // anchor the transcript against the warm accent.
  user: "#5C9CF5", ok: "#7FD88F", warn: "#F5A742", err: "#E06C75", run: "#9D7CD8", shell: "#F5C2E7", navy: "#0A0A0A",
  userBg: "#141414", codeBg: "#141414", panelBg: "#141414", elementBg: "#1E1E1E", accentBg: "#2A1E14",
  path: "#87B7F0",
  // Distinct hues so a code block isn't a wall of one blue: keyword violet,
  // function blue, type teal, string green, number amber, comment gray. Amber (not
  // red) for numbers keeps red reserved for things that went wrong.
  codeKeyword: "#C39AE8", codeString: "#A9D98C", codeNumber: "#E8C27E",
  codeComment: "#6E7681", codePunct: "#8A919C",
  codeFunction: "#82B3E8", codeType: "#7FD3C0", codeOperator: "#99A2AD", codeBracket: "#8A95A5",
  diffAddBg: "#20303B", diffDelBg: "#37222C", diffContextBg: "#141414",
};

// The same vocabulary tuned FOR a light terminal background (Gearbox never
// paints the canvas — these are inks and pale chips on the terminal's own
// white). Every hue keeps its dark-theme MEANING; only the values deepen for
// contrast on white. `navy` stays a dark ink: its semantic is "ink on an
// accent chip", not "canvas".
export const light: Theme = {
  accent: "#0E7C8C", accentDim: "#3C95A3", text: "#2A2E37", dim: "#6B7280", faint: "#9CA3AF",
  user: "#155E89", ok: "#1A7F4B", warn: "#9A6700", err: "#C2362B", run: "#4F46E5", shell: "#B83280", navy: "#0A0A0A",
  userBg: "#E3F0F9", codeBg: "#F3F4F6", panelBg: "#F3F4F6", elementBg: "#E9EBEE", accentBg: "#DFF3F6",
  path: "#1E6091",
  codeKeyword: "#7C3AED", codeString: "#3F7B27", codeNumber: "#9A6700",
  codeComment: "#6E7781", codePunct: "#57606A",
  codeFunction: "#0550AE", codeType: "#0F766E", codeOperator: "#57606A", codeBracket: "#6E7781",
  diffAddBg: "#DDF4E4", diffDelBg: "#FBE9E9", diffContextBg: "#F3F4F6",
};

// ── The gallery ───────────────────────────────────────────────────────────────
// Every palette keeps the SEMANTIC vocabulary (accent = interactive/now, ok/
// warn/err = severity, money neutral) — only the hues change. The Theme
// interface forces completeness, so a missing field is a compile error.

// Gruvbox (dark): warm retro groove — aqua accent, the classic red/green/yellow.
export const gruvbox: Theme = {
  accent: "#8EC07C", accentDim: "#689D6A", text: "#EBDBB2", dim: "#A89984", faint: "#7C6F64",
  user: "#83A598", ok: "#B8BB26", warn: "#FABD2F", err: "#FB4934", run: "#83A598", shell: "#D3869B", navy: "#1D2021",
  userBg: "#3C3836", codeBg: "#32302F", panelBg: "#32302F", elementBg: "#3C3836", accentBg: "#2E3B33",
  path: "#83A598",
  codeKeyword: "#D3869B", codeString: "#B8BB26", codeNumber: "#FABD2F",
  codeComment: "#928374", codePunct: "#A89984",
  codeFunction: "#FABD2F", codeType: "#8EC07C", codeOperator: "#A89984", codeBracket: "#928374",
  diffAddBg: "#2A3325", diffDelBg: "#3C2526", diffContextBg: "#32302F",
};

// Catppuccin (mocha): soft pastels on a deep base — teal accent, mauve keywords.
export const catppuccin: Theme = {
  accent: "#94E2D5", accentDim: "#6BB0A8", text: "#CDD6F4", dim: "#A6ADC8", faint: "#6C7086",
  user: "#89B4FA", ok: "#A6E3A1", warn: "#F9E2AF", err: "#F38BA8", run: "#B4BEFE", shell: "#F5C2E7", navy: "#11111B",
  userBg: "#202A3C", codeBg: "#313244", panelBg: "#313244", elementBg: "#45475A", accentBg: "#203437",
  path: "#89B4FA",
  codeKeyword: "#CBA6F7", codeString: "#A6E3A1", codeNumber: "#FAB387",
  codeComment: "#6C7086", codePunct: "#9399B2",
  codeFunction: "#89B4FA", codeType: "#94E2D5", codeOperator: "#9399B2", codeBracket: "#9399B2",
  diffAddBg: "#2A3B2E", diffDelBg: "#41262E", diffContextBg: "#313244",
};

// Solarized (dark): the precise low-contrast classic — cyan accent.
export const solarized: Theme = {
  accent: "#2AA198", accentDim: "#1E7D76", text: "#93A1A1", dim: "#657B83", faint: "#586E75",
  user: "#268BD2", ok: "#859900", warn: "#B58900", err: "#DC322F", run: "#6C71C4", shell: "#D33682", navy: "#002B36",
  userBg: "#073642", codeBg: "#073642", panelBg: "#073642", elementBg: "#0A4150", accentBg: "#0A3C41",
  path: "#268BD2",
  codeKeyword: "#6C71C4", codeString: "#859900", codeNumber: "#B58900",
  codeComment: "#586E75", codePunct: "#657B83",
  codeFunction: "#268BD2", codeType: "#2AA198", codeOperator: "#657B83", codeBracket: "#586E75",
  diffAddBg: "#0D3A24", diffDelBg: "#3D1A16", diffContextBg: "#073642",
};

// High contrast: maximum legibility — pure white text, saturated semantics.
export const contrast: Theme = {
  accent: "#00FFFF", accentDim: "#00B3B3", text: "#FFFFFF", dim: "#C0C0C0", faint: "#808080",
  user: "#80D4FF", ok: "#00FF66", warn: "#FFD700", err: "#FF4040", run: "#8C9EFF", shell: "#FF7AD9", navy: "#000000",
  userBg: "#002B40", codeBg: "#101010", panelBg: "#101010", elementBg: "#1C1C1C", accentBg: "#003A3A",
  path: "#66B3FF",
  codeKeyword: "#DDA0FF", codeString: "#99FF99", codeNumber: "#FFD700",
  codeComment: "#9E9E9E", codePunct: "#C0C0C0",
  codeFunction: "#66B3FF", codeType: "#00E5CC", codeOperator: "#C0C0C0", codeBracket: "#C0C0C0",
  diffAddBg: "#003D1A", diffDelBg: "#4D0F0F", diffContextBg: "#101010",
};

export interface ThemeEntry {
  name: string; // what the user types: /theme gruvbox
  label: string;
  hint: string; // one-line description in the picker
  palette: Theme;
}

export const THEMES: ThemeEntry[] = [
  { name: "dark", label: "gearbox dark", hint: "periwinkle on charcoal · the default", palette: dark },
  { name: "light", label: "gearbox light", hint: "the same vocabulary tuned for white terminals", palette: light },
  { name: "gruvbox", label: "gruvbox", hint: "warm retro groove · aqua accent", palette: gruvbox },
  { name: "catppuccin", label: "catppuccin mocha", hint: "soft pastels on a deep base", palette: catppuccin },
  { name: "solarized", label: "solarized dark", hint: "the precise low-contrast classic", palette: solarized },
  { name: "contrast", label: "high contrast", hint: "maximum legibility · pure white text", palette: contrast },
];

// THE theme object every component reads (`color.accent` at render time).
// Mutated in place by setTheme so all importers stay untouched — never
// destructure `color` at module scope (the values would go stale on switch).
export const color: Theme = { ...dark };

export type ThemeName = string;

// Bumped on every switch; render caches that bake hex strings (lines.ts
// staticLineCache) compare this to know their colors are stale.
export let themeEpoch = 0;

let currentTheme = "dark";

export function activeTheme(): string {
  return currentTheme;
}

export function themeByName(name: string): ThemeEntry | undefined {
  const q = name.trim().toLowerCase();
  return THEMES.find((t) => t.name === q) ?? THEMES.find((t) => t.name.startsWith(q) || t.label.toLowerCase().includes(q));
}

/** Switch the palette in place. Returns false (and changes nothing) for an
 *  unknown name. */
export function setTheme(name: string): boolean {
  const entry = themeByName(name);
  if (!entry) return false;
  Object.assign(color, entry.palette);
  currentTheme = entry.name;
  themeEpoch++;
  return true;
}

// Install-screen wordmark gradient: same hue as the in-app accent so the
// onboarding figlet and the running app read as one brand. Bright accent →
// mid teal → deep teal. Same-hue cyan→teal only — NO blue/indigo stop.
// (Captured at import; startup-only, so a runtime theme switch doesn't apply.)
export const wordmarkGradient = [dark.accent, "#E29362", "#B5714A"];

// A considered set, not emoji: a quarter-block spine for your turns, a filled
// circle + result connector for tool calls (status shown by the circle's COLOR,
// not a tick), an angle prompt, a hairline rule. Restraint over decoration.
export const glyph = {
  prompt: "❯", // composer
  userBar: "▌", // the colored spine on your messages (thin ▎ = glyph.quote)
  corner: "∟", // collapsed tool stub (the opencode-style step marker)
  tool: "⏺", // tool call (color = status)
  result: "⎿", // tool result / continuation
  branch: "⎇", // git branch
  notice: "◆", // notices
  err: "▲", // hard errors
  bullet: "·",
  rule: "─",
  on: "●",
  off: "○",
  // One marker per meaning, everywhere (a glyph with two meanings reads as
  // noise): ▶ = the selected row in ANY list, ◌ = running/in-flight,
  // ✓/✗ = done-ok / done-failed, ▎ = a thin quote/error spine.
  select: "▶",
  running: "◌",
  check: "✓",
  cross: "✗",
  quote: "▎",
} as const;
