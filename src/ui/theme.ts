// The look lives here. Change colors/glyphs in one place, never inline.
// Restraint is the aesthetic: one cool accent (periwinkle — the ghost mascot),
// near-black canvas so the accent reads without competing background hues,
// color only used to mean something (running / ok / error).

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

// Periwinkle-on-charcoal. Near-black canvas so the accent pops without a blue-tinted
// background. Syntax uses a single accent family (blues) + violet for types.
export const color: Theme = {
  accent: "#7DD3FC", accentDim: "#60A5FA", text: "#E2E8F0", dim: "#94A3B8", faint: "#64748B",
  user: "#BAE6FD", ok: "#4ADE80", err: "#F87171", run: "#818CF8", navy: "#111111",
  userBg: "#0D2137", codeBg: "#0D0D0D", panelBg: "#161616", accentBg: "#0A1628",
  path: "#7DD3FC",
  codeKeyword: "#7DD3FC", codeString: "#A7F3D0", codeNumber: "#A5B4FC",
  codeComment: "#4B5563", codePunct: "#6B7280",
  codeFunction: "#93C5FD", codeType: "#C4B5FD", codeOperator: "#6B7280", codeBracket: "#60A5FA",
  diffAddBg: "#052E16", diffDelBg: "#2D0A0A", diffContextBg: "#0D0D0D",
};

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
