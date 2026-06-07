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
export const color: Theme = {
  accent: "#56D4E0", accentDim: "#4F8C99", text: "#E4E6EB", dim: "#8A909C", faint: "#5B626E",
  user: "#BFE0F0", ok: "#6FCF97", err: "#E5675C", run: "#7E8AF0", shell: "#E27BB0", navy: "#0E0F13",
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
