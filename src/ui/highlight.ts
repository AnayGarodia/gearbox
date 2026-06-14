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
const BUILTINS = new Set(
  (
    "print input open len str int float list dict set tuple range enumerate zip map filter sum min max abs round sorted reversed " +
    "json os sys re pathlib argparse datetime Counter defaultdict Any Optional Union Literal self cls False True None"
  ).split(" "),
);

const HASH_COMMENT_LANGS = /^(py|python|sh|bash|zsh|fish|yaml|yml|rb|ruby|toml|ini|conf|cfg|makefile|make|dockerfile|r|pl|perl|nim|elixir|ex|exs)$/i;
const TYPE_CONTEXT = new Set(["class", "interface", "type", "struct", "enum", "trait"]);
const FN_CONTEXT = new Set(["def", "function", "func", "fn"]);
const BRACKETS = new Set(["(", ")", "[", "]", "{", "}"]);
const OPERATORS = new Set(["=", "+", "-", "*", "/", "%", "!", "<", ">", "&", "|", "^", "~", "?", ":"]);
// Brackets are ONE muted color, not a rainbow. Depth-rotating bracket hues read
// as chaos in a small transcript block (the "horrible code formatting" report);
// structure comes from indentation, not color.

const nextNonSpace = (line: string, i: number) => {
  let j = i;
  while (j < line.length && /\s/.test(line[j]!)) j++;
  return line[j] ?? "";
};

const previousWord = (line: string, i: number) => {
  const left = line.slice(0, i).trimEnd();
  return left.match(/[A-Za-z_$][\w$]*$/)?.[0] ?? "";
};

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
      push(line.slice(i), color.codeComment);
      break;
    }
    // decorators / annotations
    if (c === "@" && /[A-Za-z_]/.test(line[i + 1] ?? "")) {
      let j = i + 1;
      while (j < line.length && /[\w.]/.test(line[j]!)) j++;
      push(line.slice(i, j), color.codeFunction, { bold: true });
      i = j;
      continue;
    }
    // string (single-line; tolerates escapes)
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < line.length && line[j] !== c) {
        if (line[j] === "\\") j++;
        j++;
      }
      const end = Math.min(j + 1, line.length);
      push(line.slice(i, end), color.codeString);
      i = end;
      continue;
    }
    // number
    if (/[0-9]/.test(c) && !/[\w]/.test(prev)) {
      let j = i;
      while (j < line.length && /[0-9._xXa-fA-F]/.test(line[j]!)) j++;
      push(line.slice(i, j), color.codeNumber);
      i = j;
      continue;
    }
    // identifier / keyword
    if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < line.length && /[\w$]/.test(line[j]!)) j++;
      const w = line.slice(i, j);
      const prevWord = previousWord(line, i);
      const next = nextNonSpace(line, j);
      const prevSig = line.slice(0, i).trimEnd().slice(-1);
      const nextSig = line.slice(j).trimStart()[0] ?? "";
      if (KEYWORDS.has(w)) push(w, color.codeKeyword, { bold: true });
      else if (FN_CONTEXT.has(prevWord)) push(w, color.codeFunction, { bold: true });
      else if (TYPE_CONTEXT.has(prevWord)) push(w, color.codeType, { bold: true });
      else if (BUILTINS.has(w)) push(w, color.codeType);
      else if (next === "(") push(w, color.codeFunction, prevSig === "." ? undefined : { bold: true });
      // Member access (`.field`) and bare identifiers stay neutral text — coloring
      // every `.py`/`.api` segment teal turned shell + dotted paths into noise.
      else if (/^[A-Z]/.test(w) && prevSig !== ".") push(w, color.codeType);
      else push(w, color.text);
      i = j;
      continue;
    }
    if (BRACKETS.has(c)) {
      push(c, color.codeBracket);
      i++;
      continue;
    }
    if (OPERATORS.has(c)) {
      let j = i;
      while (j < line.length && OPERATORS.has(line[j]!)) j++;
      push(line.slice(i, j), color.codeOperator);
      i = j;
      continue;
    }
    push(c, color.codePunct);
    i++;
  }
  return out.length ? out : [{ text: line, dim: true }];
}
