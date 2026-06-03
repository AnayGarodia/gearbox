// The look lives here. Change colors/glyphs in one place, never inline.
// Restraint is the aesthetic: one cool accent (periwinkle — the ghost mascot),
// calm lavender-grays on navy, color used only to mean something
// (running / ok / error). Palette is drawn from the mascot sprite so the whole
// UI and the ghost are one family.

export const color = {
  accent: "#A5B4FC", // periwinkle — brand + the routed/active signal (the ghost's hue)
  accentDim: "#6E76B0",
  text: "#DCE2F7", // soft lavender-white (the ghost's body)
  dim: "#8A91B4",
  faint: "#565E80",
  user: "#7FB7E8", // cool blue — your words
  ok: "#7FD7A8", // mint — calm success
  err: "#F0868C", // soft coral — only for failure
  run: "#A5B4FC", // periwinkle — active/streaming
  navy: "#1E1B4B", // deep indigo (the ghost's eyes) — for framing/fills
} as const;

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
