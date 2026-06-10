// Terminal display-column measurement. `.length` counts UTF-16 code units, not
// columns: emoji and CJK occupy 2 cells, combining marks 0, and a surrogate pair
// is 2 units but one glyph. Everything in lines.ts that does column math goes
// through these three pure helpers so the ≤width invariant holds for any text.

// One precompiled combining-mark check (Mn/Me/Mc); only consulted for cp ≥ U+0300
// so ASCII never touches a regex.
const COMBINING_RE = /\p{M}/u;

/** Display width of one code point: 0 (combining/zero-width), 2 (East Asian
 *  Wide/Fullwidth + emoji planes), else 1. Fast numeric range checks. */
export function charWidth(cp: number): number {
  if (cp < 0x300) return 1; // ASCII + Latin-1: always narrow
  // zero-width: ZWSP/ZWNJ/ZWJ, variation selectors, BOM, combining marks
  if (cp >= 0x200b && cp <= 0x200d) return 0;
  if (cp >= 0xfe00 && cp <= 0xfe0f) return 0;
  if (cp === 0xfeff) return 0;
  if (COMBINING_RE.test(String.fromCodePoint(cp))) return 0;
  // East Asian Wide / Fullwidth
  if (cp >= 0x1100 && cp <= 0x115f) return 2; // Hangul Jamo
  if (cp >= 0x2e80 && cp <= 0xa4cf) return 2; // CJK radicals … Yi
  if (cp >= 0xac00 && cp <= 0xd7a3) return 2; // Hangul syllables
  if (cp >= 0xf900 && cp <= 0xfaff) return 2; // CJK compatibility ideographs
  if (cp >= 0xfe30 && cp <= 0xfe4f) return 2; // CJK compatibility forms
  if (cp >= 0xff00 && cp <= 0xff60) return 2; // fullwidth forms
  if (cp >= 0xffe0 && cp <= 0xffe6) return 2; // fullwidth signs
  if (cp >= 0x1f300 && cp <= 0x1f9ff) return 2; // emoji & symbols
  if (cp >= 0x1fa00 && cp <= 0x1faff) return 2; // symbols extended-A
  if (cp >= 0x20000 && cp <= 0x2fffd) return 2; // CJK extension planes
  if (cp >= 0x30000 && cp <= 0x3fffd) return 2;
  return 1;
}

// Anything outside printable ASCII forces the per-code-point path.
const NON_ASCII_RE = /[^\x20-\x7e]/;

/** Display width of a string in terminal columns. */
export function displayWidth(s: string): number {
  if (!NON_ASCII_RE.test(s)) return s.length; // pure-ASCII fast path
  let w = 0;
  for (const ch of s) w += charWidth(ch.codePointAt(0)!); // for..of keeps surrogate pairs whole
  return w;
}

/** Longest prefix of `s` whose display width ≤ max — never splits a surrogate
 *  pair. Returns the prefix and its exact width (a trailing wide char that
 *  doesn't fit is left out, so width may be < max). */
export function sliceWidth(s: string, max: number): { text: string; width: number } {
  if (max <= 0) return { text: "", width: 0 };
  if (!NON_ASCII_RE.test(s)) {
    const text = s.length > max ? s.slice(0, max) : s; // pure-ASCII fast path
    return { text, width: text.length };
  }
  let w = 0;
  let end = 0;
  for (const ch of s) {
    const cw = charWidth(ch.codePointAt(0)!);
    if (w + cw > max) break;
    w += cw;
    end += ch.length; // 1 or 2 UTF-16 units — the pair stays whole
  }
  return { text: s.slice(0, end), width: w };
}
