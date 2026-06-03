// Repo map — a compact structural signature map of the project (path + the
// export/function/class/interface/type/const lines), token-budgeted. Gives the
// model whole-repo AWARENESS for a fraction of the tokens of dumping files
// (experiments/context: ~4.7× cheaper than a full dump). Structural, not
// embeddings; lexical retrieval (retrieve.ts) pulls the actual file bodies.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { listProjectFiles } from "../ui/files.ts";
import { countTokens } from "../model/tokens.ts";

const CODE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|c|h|cpp|hpp)$/;
const SIG =
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|const|enum)\s+[A-Za-z_][A-Za-z0-9_]*/;

/** A signature map for the project, capped to `budget` tokens. src/ files first. */
export function repoMap(cwd = process.cwd(), budget = 4000): string {
  const files = listProjectFiles(cwd)
    .filter((f) => CODE.test(f))
    .sort((a, b) => Number(b.startsWith("src/")) - Number(a.startsWith("src/")) || a.localeCompare(b));

  const blocks: string[] = [];
  let used = 0;
  for (const f of files) {
    let src: string;
    try {
      src = readFileSync(resolve(cwd, f), "utf8");
    } catch {
      continue;
    }
    const sigs = src
      .split("\n")
      .filter((l) => SIG.test(l))
      .map((l) => "  " + l.replace(/\s*\{?\s*$/, "").trim());
    if (!sigs.length) continue;
    const block = `${f}\n${sigs.join("\n")}`;
    const cost = countTokens(block);
    if (used + cost > budget) {
      if (!blocks.length) blocks.push(block); // always include at least one
      break;
    }
    blocks.push(block);
    used += cost;
  }
  return blocks.join("\n");
}
