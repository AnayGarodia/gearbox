// Lightweight, language-agnostic syntax highlighter for code blocks. Per-line
// (no multi-line string/comment state) which is plenty for a transcript, and it
// emits styled SPANS — never raw ANSI — so Ink keeps control of width/wrapping
// (the project's hard rule). Pure + unit-tested.
import { color } from "./theme.ts";

export interface HSpan {
  text: string;
  color?: string;
  bold?: boolean;
  dim?: boolean;
}

// A pragmatic union of keywords across the languages a coding agent emits most.
const KEYWORDS = new Set(
  (
    "function return if else elif for while do const let var import from export default class new this super extends " +
    "implements interface type enum public private protected static async await try catch finally throw typeof instanceof " +
    "in of yield void null undefined true false def lambda pass with as None True False and or not is print fn pub use mut " +
    "struct impl match trait where move ref Some Ok Err package func defer go chan map range switch case break continue " +
    "select then end module require begin rescue ensure self nil echo local set unset"
  ).split(" "),
);

const HASH_COMMENT_LANGS = /^(py|python|sh|bash|zsh|fish|yaml|yml|rb|ruby|toml|ini|conf|cfg|makefile|make|dockerfile|r|pl|perl|nim|elixir|ex|exs)$/i;

/** Tokenize one line into colored spans. `lang` tweaks the comment marker. */
export function highlightLine(line: string, lang = ""): HSpan[] {
  const out: HSpan[] = [];
  const hash = HASH_COMMENT_LANGS.test(lang);
  const push = (text: string, c?: string, extra?: Partial<HSpan>) => {
    if (text) out.push({ text, color: c, ...extra });
  };
  let i = 0;
  while (i < line.length) {
    const c = line[i]!;
    const prev = i > 0 ? line[i - 1]! : "";
    // line comment
    if ((c === "/" && line[i + 1] === "/") || (hash && c === "#") || (c === "-" && line[i + 1] === "-" && /^(lua|sql|hs|haskell)$/i.test(lang))) {
      push(line.slice(i), color.faint);
      break;
    }
    // string (single-line; tolerates escapes)
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < line.length && line[j] !== c) {
        if (line[j] === "\\") j++;
        j++;
      }
      const end = Math.min(j + 1, line.length);
      push(line.slice(i, end), color.ok);
      i = end;
      continue;
    }
    // number
    if (/[0-9]/.test(c) && !/[\w]/.test(prev)) {
      let j = i;
      while (j < line.length && /[0-9._xXa-fA-F]/.test(line[j]!)) j++;
      push(line.slice(i, j), color.user);
      i = j;
      continue;
    }
    // identifier / keyword
    if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < line.length && /[\w$]/.test(line[j]!)) j++;
      const w = line.slice(i, j);
      if (KEYWORDS.has(w)) push(w, color.accent, { bold: true });
      else push(w, color.text);
      i = j;
      continue;
    }
    push(c, color.dim);
    i++;
  }
  return out.length ? out : [{ text: line, dim: true }];
}
