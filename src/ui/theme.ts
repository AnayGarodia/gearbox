// The look lives here. Change colors/glyphs in one place, never inline.
// Restraint is the aesthetic: one warm accent (brass — "gearbox"), calm grays,
// color used only to mean something (running / ok / error).

export const color = {
  accent: "#E0A458", // brass — brand + the routed/active signal
  accentDim: "#9A7B4F",
  text: "#EAEAEA",
  dim: "#7A7A7A",
  faint: "#555555",
  user: "#7FB7E8", // cool blue — your words
  ok: "#8FBF73",
  err: "#E0696F",
  run: "#E0A458",
} as const;

export const glyph = {
  gear: "⚙",
  prompt: "›",
  user: "›",
  assistant: "⏺",
  tool: "↳",
  ok: "✓",
  err: "✗",
  bullet: "·",
  rule: "─",
  notice: "◇",
  on: "●",
  off: "○",
} as const;
