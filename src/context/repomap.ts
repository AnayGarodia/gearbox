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
// Import specifiers, so we can build a cheap dependency graph: ESM from-imports,
// dynamic import()/require(), and Python from/import. We only need the target.
const IMPORT = /(?:from\s*['"]([^'"]+)['"])|(?:require\(\s*['"]([^'"]+)['"]\s*\))|(?:import\(\s*['"]([^'"]+)['"]\s*\))|(?:^\s*(?:from|import)\s+([A-Za-z0-9_.]+))/gm;

// Module "name" used to match an import specifier to a repo file: the last path
// segment, minus a code extension. "./model/router.ts" → "router"; "../a/b" → "b".
const moduleName = (spec: string): string => (spec.split("/").pop() ?? spec).replace(CODE, "").replace(/\.[^.]+$/, "");

/**
 * A signature map for the project, capped to `budget` tokens. Files are ranked by
 * IN-DEGREE (how many other files import each module) so the most depended-on code
 * survives the budget — a cheap dependency-graph proxy for Aider's PageRank repo
 * map, with zero model calls. src/ still floats first; in-degree breaks ties before
 * alphabetical. Reads each file once (imports + signatures in the same pass).
 */
export function repoMap(cwd = process.cwd(), budget = 4000): string {
  const files = listProjectFiles(cwd).filter((f) => CODE.test(f));

  // One read per file: capture its signatures AND the modules it imports.
  const parsed: { file: string; sigs: string[]; imports: Set<string> }[] = [];
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
    if (!sigs.length) continue; // nothing to show for this file
    const imports = new Set<string>();
    for (const m of src.matchAll(IMPORT)) {
      const spec = m[1] ?? m[2] ?? m[3] ?? m[4];
      if (spec) imports.add(moduleName(spec));
    }
    parsed.push({ file: f, sigs, imports });
  }

  // In-degree: how many DISTINCT files import each module name (dedup per file via
  // the Set above, so a file importing the same module twice counts once).
  const inDegree = new Map<string, number>();
  for (const p of parsed) for (const name of p.imports) inDegree.set(name, (inDegree.get(name) ?? 0) + 1);
  const scoreOf = (file: string): number => inDegree.get(moduleName(file)) ?? 0;

  parsed.sort(
    (a, b) =>
      Number(b.file.startsWith("src/")) - Number(a.file.startsWith("src/")) ||
      scoreOf(b.file) - scoreOf(a.file) ||
      a.file.localeCompare(b.file),
  );

  const blocks: string[] = [];
  let used = 0;
  for (const p of parsed) {
    const block = `${p.file}\n${p.sigs.join("\n")}`;
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
