// The PROSE highlighter, shared by both render paths (lines.ts fullscreen +
// Markdown.tsx inline) so they can never drift. The goal is rich BUT precise:
// the tokens that actually matter in a coding agent's replies are highlighted,
// and ordinary English is left alone. Every alternative is anchored/bounded so it
// can't run past its token (the old highlighter's bug was greedy captures — an
// apostrophe pairing across a sentence, a command word eating to the next period,
// a "word:" label spanning several words).
//
// What gets highlighted, each matched tightly:
//   `inline code`            — backtick span
//   /slash-command, /path    — leading slash at a word boundary
//   src/ui/theme.ts          — a path/filename ending in a known extension
//   Claude, OpenAI, Gearbox  — a curated set of product names
//   fn(…)                    — an identifier immediately followed by "("
//   snake_case, camelCase    — code identifiers (internal _ or a…Z hump)
//   PascalCaseType           — a compound type name (Cap…Cap)
//   "a short quote"          — a bounded double-quoted phrase
//   42                       — a number
import { color } from "./theme.ts";

const EXT =
  "ts|tsx|js|jsx|mjs|cjs|json|md|py|go|rs|sh|bash|zsh|css|scss|html|txt|toml|yml|yaml|lock|sql|env|ini|conf";

// One combined, ordered alternation. Earlier alternatives win at a given start
// position, so products are listed before the generic identifier shapes.
export const PROSE_RE = new RegExp(
  [
    "`[^`]+`", // inline code
    "(?:^|\\s)\\/[\\w][\\w/.-]*", // /slash-command or /abs/path (slash must follow start or space, so "and/or" is safe)
    `\\b(?:[\\w-]+\\/)*[\\w-]+\\.(?:${EXT})\\b`, // path/filename with a known extension
    "\\b(?:Claude|ChatGPT|Anthropic|OpenAI|OpenRouter|Gemini|Gearbox|DeepSeek|TypeScript|JavaScript|React)\\b", // product names
    "\\b[A-Za-z_]\\w*(?=\\()", // identifier directly before "(" — a call
    "\\b[a-z][a-z0-9]*_\\w+\\b", // snake_case
    "\\b[a-z][a-z0-9]*[A-Z]\\w*\\b", // camelCase
    "\\b[A-Z][a-z0-9]+[A-Z]\\w*\\b", // PascalCase compound (needs an internal capital, so "However" is safe)
    '"[^"\\n]{1,48}"', // a short double-quoted phrase
    "\\b\\d+(?:\\.\\d+)?\\b", // number
  ].join("|"),
  "g",
);

const PRODUCTS = new Set([
  "Claude", "ChatGPT", "Anthropic", "OpenAI", "OpenRouter", "Gemini",
  "Gearbox", "DeepSeek", "TypeScript", "JavaScript", "React",
]);

export interface ProseStyle {
  color: string;
  bold?: boolean;
  bg?: string;
}

// Map a matched token (leading whitespace already stripped by the caller) to its
// style. Derived from the token's shape, so both render paths color it the same.
export function proseTokenStyle(token: string): ProseStyle {
  // Code-ish tokens read in the calm path-blue, never the bright accent — accent
  // is reserved for interactive/now (the composer, a clickable command, the active
  // tab), so a symbol name in prose can't be mistaken for something you act on.
  if (token.startsWith("`")) return { color: color.path, bg: color.codeBg };
  if (token.startsWith("/")) return { color: color.path, bold: true, bg: color.accentBg };
  if (token.startsWith('"')) return { color: color.codeString };
  if (/^\d/.test(token)) return { color: color.codeNumber };
  if (PRODUCTS.has(token)) return { color: color.user, bold: true };
  // path/filename: contains a slash or ends in a dotted extension
  if (token.includes("/") || /\.[A-Za-z0-9]+$/.test(token)) return { color: color.path };
  // otherwise a code identifier (call / snake / camel / Pascal)
  return { color: color.path };
}
