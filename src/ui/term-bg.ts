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
 *  or null if the buffer isn't a background reply. */
export function parseOsc11(buf: string): number | null {
  const m = /\]\s*11;rgba?:([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})/.exec(buf);
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

/**
 * Ask the terminal for its background color. Resolves "light" | "dark" | null
 * (unknown). Must run BEFORE Ink mounts (it briefly takes raw mode); bounded
 * by `timeoutMs` so a terminal that never answers can't stall startup.
 */
export function queryTerminalBackground(timeoutMs = 150): Promise<"light" | "dark" | null> {
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
      if (lum != null) finish(isLightLuminance(lum) ? "light" : "dark");
      // Anything else (a keypress racing the reply) just accumulates until timeout.
    };
    const timer = setTimeout(() => {
      // No OSC reply — try the env fallback before giving up.
      const fb = colorFgBgIsLight(process.env.COLORFGBG);
      finish(fb == null ? null : fb ? "light" : "dark");
    }, timeoutMs);
    try {
      stdin.setRawMode?.(true);
      stdin.resume();
      stdin.on("data", onData);
      stdout.write("\x1b]11;?\x07");
    } catch {
      finish(null);
    }
  });
}
