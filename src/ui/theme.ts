// The look lives here. Change colors/glyphs in one place, never inline.
// Restraint is the aesthetic: one cool accent (periwinkle — the ghost mascot),
// near-black canvas so the accent reads without competing background hues,
// color only used to mean something (running / ok / error).
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

// Periwinkle-on-charcoal. Near-black canvas so the accent pops without a blue-tinted
// background. Syntax uses a single accent family (blues) + violet for types.
export const dark: Theme = {
  accent: "#56D4E0", accentDim: "#4F8C99", text: "#E4E6EB", dim: "#8A909C", faint: "#5B626E",
  // `warn` is the ONLY amber in the semantic vocabulary — spent sparingly on a
  // surprising routing decision, a balance running low, or a key needing
  // attention. Same hue as the code-number amber, kept distinct from `err` (red
  // = something went wrong) so amber can mean "look, but nothing is broken".
  user: "#BFE0F0", ok: "#6FCF97", warn: "#E0B057", err: "#E5675C", run: "#7E8AF0", shell: "#E27BB0", navy: "#0E0F13",
  userBg: "#0E2233", codeBg: "#16181E", panelBg: "#16181E", accentBg: "#0E2027",
  path: "#86B8E0",
  // Distinct hues so a code block isn't a wall of one blue: keyword violet,
  // function cyan, type teal, string green, number amber, comment gray. Amber (not
  // red) for numbers keeps red reserved for things that went wrong.
  codeKeyword: "#C7A0F0", codeString: "#B9E08A", codeNumber: "#E0B057",
  codeComment: "#6E7681", codePunct: "#7E8696",
  codeFunction: "#74B0E6", codeType: "#79D9C2", codeOperator: "#94A0AE", codeBracket: "#8C95A8",
  diffAddBg: "#103A22", diffDelBg: "#3A1414", diffContextBg: "#16181E",
};

// The same vocabulary tuned FOR a light terminal background (Gearbox never
// paints the canvas — these are inks and pale chips on the terminal's own
// white). Every hue keeps its dark-theme MEANING; only the values deepen for
// contrast on white. `navy` stays a dark ink: its semantic is "ink on an
// accent chip", not "canvas".
export const light: Theme = {
  accent: "#0E7C8C", accentDim: "#3C95A3", text: "#2A2E37", dim: "#6B7280", faint: "#9CA3AF",
  user: "#155E89", ok: "#1A7F4B", warn: "#9A6700", err: "#C2362B", run: "#4F46E5", shell: "#B83280", navy: "#0E0F13",
  userBg: "#E3F0F9", codeBg: "#F3F4F6", panelBg: "#F3F4F6", accentBg: "#DFF3F6",
  path: "#1E6091",
  codeKeyword: "#7C3AED", codeString: "#3F7B27", codeNumber: "#9A6700",
  codeComment: "#6E7781", codePunct: "#57606A",
  codeFunction: "#0550AE", codeType: "#0F766E", codeOperator: "#57606A", codeBracket: "#6E7781",
  diffAddBg: "#DDF4E4", diffDelBg: "#FBE9E9", diffContextBg: "#F3F4F6",
};

// THE theme object every component reads (`color.accent` at render time).
// Mutated in place by setTheme so all importers stay untouched — never
// destructure `color` at module scope (the values would go stale on switch).
export const color: Theme = { ...dark };

export type ThemeName = "dark" | "light";

// Bumped on every switch; render caches that bake hex strings (lines.ts
// staticLineCache) compare this to know their colors are stale.
export let themeEpoch = 0;

export function activeTheme(): ThemeName {
  return color.text === light.text ? "light" : "dark";
}

export function setTheme(name: ThemeName): void {
  Object.assign(color, name === "light" ? light : dark);
  themeEpoch++;
}

// Install-screen wordmark gradient: same hue as the in-app accent so the
// onboarding figlet and the running app read as one brand. Bright accent →
// mid teal → deep teal. Same-hue cyan→teal only — NO blue/indigo stop.
// (Captured at import; startup-only, so a runtime theme switch doesn't apply.)
export const wordmarkGradient = [dark.accent, "#3AA7B5", "#1F6B76"];

// A considered set, not emoji: a quarter-block spine for your turns, a filled
// circle + result connector for tool calls (status shown by the circle's COLOR,
// not a tick), an angle prompt, a hairline rule. Restraint over decoration.
export const glyph = {
  prompt: "❯", // composer
  userBar: "▌", // the colored spine on your messages (thin ▎ = glyph.quote)
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
