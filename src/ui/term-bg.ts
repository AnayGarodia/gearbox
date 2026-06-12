/**
 * term-bg.ts — detect the TERMINAL's background color so gearbox picks a
 * readable default palette automatically.
 *
 * The dark palette is unreadable on a white native terminal theme (and vice
 * versa) — user-reported. When the user has NOT explicitly chosen a theme,
 * cli.tsx asks the terminal what its background actually is:
 *
 *   1. OSC 11 query (`ESC ] 11 ; ? BEL`) — supported by every modern terminal
 *      (Terminal.app, iTerm2, Ghostty, Kitty, WezTerm, Alacritty, VS Code,
 *      tmux passthrough). The reply carries the real background color.
 *   2. COLORFGBG env fallback (set by some terminals/screen): "fg;bg" where a
 *      bg index ≥ 7 (excluding 8, "dark gray") means a light background.
 *
 * Parsing is pure and tested; only queryTerminalBackground touches the TTY.
 */

/** Parse an OSC 11 reply (`ESC]11;rgb:RRRR/GGGG/BBBB` style, BEL or ST
 *  terminated; channels may be 1-4 hex digits) → relative luminance 0..1,
 *  or null if the buffer doesn't (yet) hold a complete background reply.
 *  The terminator is REQUIRED: a partial reply must keep accumulating, never
 *  half-parse. */
export function parseOsc11(buf: string): number | null {
  const m = /\]\s*11;rgba?:([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})(?:\/[0-9a-fA-F]{1,4})?(?:\x07|\x1b\\)/.exec(buf);
  if (!m) return null;
  // Scale each channel by its own digit width: "ff" → 255/255, "ffff" → 65535/65535.
  const chan = (s: string) => parseInt(s, 16) / (Math.pow(16, s.length) - 1);
  const [r, g, b] = [chan(m[1]!), chan(m[2]!), chan(m[3]!)];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Light/dark from a luminance, with a conservative threshold: mid-gray
 *  backgrounds stay on the dark palette (its contrast degrades more gracefully). */
export const isLightLuminance = (lum: number): boolean => lum > 0.55;

/** COLORFGBG fallback ("15;0", "0;15", sometimes "default;default"). The LAST
 *  field is the background's 16-color index; 7 and 9–15 are light. */
export function colorFgBgIsLight(env: string | undefined): boolean | null {
  if (!env) return null;
  const bg = env.split(";").pop()?.trim();
  if (!bg || !/^\d+$/.test(bg)) return null;
  const idx = parseInt(bg, 10);
  return idx === 7 || (idx >= 9 && idx <= 15);
}

/** Strip the control replies the probe elicited (OSC 11 + DA1) from captured
 *  stdin bytes, returning what the USER actually typed during the window. */
export function stripProbeReplies(buf: string): string {
  return buf
    .replace(/\x1b\]\s*11;[^\x07\x1b]*(?:\x07|\x1b\\)/g, "") // OSC 11 reply (BEL or ST terminated)
    .replace(/\x1b\[\?[\d;]*c/g, ""); // DA1 reply
}

/**
 * Ask the terminal for its background color. Resolves "light" | "dark" | null
 * (unknown). Must run BEFORE Ink mounts (it briefly takes raw mode).
 *
 * Free signals first: COLORFGBG answers without touching the TTY. Then the
 * OSC 11 query is paired with a DA1 sentinel (`ESC[c`) — every terminal
 * answers DA1, and replies are ordered, so seeing the DA1 reply means the
 * OSC 11 answer either already arrived or never will. That bounds the wait
 * deterministically instead of by a fixed RTT guess, which is what made the
 * old 150ms version leak late replies into Ink over ssh/tmux (phantom Esc +
 * `]11;rgb:…` typed into the composer). `timeoutMs` (now generous) remains
 * only as the safety net for terminals that answer neither.
 *
 * Keystrokes racing the probe are NOT eaten: on finish, the elicited replies
 * are stripped from the captured bytes and the residue is pushed back onto
 * stdin (unshift) for Ink to consume.
 */
export function queryTerminalBackground(timeoutMs = 1000): Promise<"light" | "dark" | null> {
  // The env var is free and set by terminals that may not answer OSC 11 at
  // all (older screen/rxvt) — read it before touching the TTY.
  const fb = colorFgBgIsLight(process.env.COLORFGBG);
  if (fb != null) return Promise.resolve(fb ? "light" : "dark");
  return new Promise((resolve) => {
    const { stdin, stdout } = process;
    if (!stdin.isTTY || !stdout.isTTY) return resolve(null);
    let buf = "";
    let done = false;
    const wasRaw = stdin.isRaw;
    const finish = (verdict: "light" | "dark" | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stdin.off("data", onData);
      try {
        // Give back anything the user typed while we probed.
        const residue = stripProbeReplies(buf);
        if (residue) stdin.unshift(Buffer.from(residue, "utf8"));
        if (!wasRaw) stdin.setRawMode?.(false);
        stdin.pause(); // leave stdin as we found it; Ink re-opens it
      } catch {
        /* never break startup over tty restoration */
      }
      resolve(verdict);
    };
    const onData = (c: Buffer) => {
      buf += c.toString("utf8");
      const lum = parseOsc11(buf);
      if (lum != null) return finish(isLightLuminance(lum) ? "light" : "dark");
      // DA1 reply seen → the terminal answered the LATER query, so OSC 11 is
      // not coming. Don't wait for the timeout.
      if (/\x1b\[\?[\d;]*c/.test(buf)) return finish(null);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    try {
      stdin.setRawMode?.(true);
      stdin.resume();
      stdin.on("data", onData);
      stdout.write("\x1b]11;?\x07\x1b[c");
    } catch {
      finish(null);
    }
  });
}
