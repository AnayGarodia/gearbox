// ── MASCOT STUB ───────────────────────────────────────────────────────────
// The hand-drawn ASCII mascot was crude. The real mascot comes from Claude
// Design (the prompt asks for idle / thinking / done / oops poses as small,
// monospace-aligned Unicode art + color tokens).
//
// To wire it in, render the art here, e.g.:
//   import { Box, Text } from "ink";
//   import { color } from "../theme.ts";
//   const SPLASH = ["…line1…", "…line2…", …];     // big entry pose
//   const MINI = { idle: "…", busy: "…" };          // tiny input pose
//   export function MascotSplash() { return <Box flexDirection="column">…</Box>; }
//
// Until then both render nothing — clean: the Banner gives the wordmark, the
// rotating verbs give the personality. These stay wired in App, so dropping in
// the designed art is a one-file change. Keep every pose box-drawing + 1-cell
// glyphs so it stays aligned in the terminal.

/** Big splash on the entry screen. (Awaiting Claude Design art.) */
export function MascotSplash() {
  return null;
}

/** Tiny mascot perched on the input box. (Awaiting Claude Design art.) */
export function MascotMini(_props: { busy: boolean }) {
  return null;
}
