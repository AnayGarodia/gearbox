/**
 * Repo Map: a compact structural signature of the whole project.
 *
 * Each code file is represented as its path plus the lines that declare an
 * exported function, class, interface, type, const, or enum. The result is a
 * token-budgeted string injected into the stable system prefix by builder.ts,
 * giving the model whole-repo awareness without dumping full file bodies.
 *
 * Why not just include all files? Experiments (experiments/context/FINDINGS.md)
 * showed the signature map is ~4.7x cheaper than a full file dump for the same
 * structural awareness. The model reads individual files on demand via read_file
 * when it needs implementation details.
 *
 * Ranking strategy: files are sorted by IMPORT IN-DEGREE, i.e. how many other
 * repo files import each module. Highly depended-on modules (utilities, routers,
 * types) float to the top, so they survive the budget cap. This is a cheap
 * proxy for the PageRank-style repo map in Aider, achieved with a single
 * lexical pass over import statements. No model calls, no embeddings.
 *
 * Sort order (descending priority):
 *   1. src/ files before everything else (source beats tests/scripts).
 *   2. Import in-degree (most-imported modules first).
 *   3. Alphabetical path (stable tie-breaker).
 *
 * Files are added greedily in sorted order until the token budget is exhausted.
 * At least one file is always included even if it alone exceeds the budget.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { listProjectFiles } from "../ui/files.ts";
import { countTokens } from "../model/tokens.ts";

// Code file extensions that are worth including in the map. Non-code assets
// (JSON, markdown, YAML, etc.) have no signatures worth extracting.
const CODE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|c|h|cpp|hpp)$/;

// Signature line regex: matches a line that declares a named top-level symbol.
// Anchored to start-of-line whitespace so nested declarations are excluded.
const SIG =
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|const|enum)\s+[A-Za-z_][A-Za-z0-9_]*/;

// Import patterns used to build a cheap in-degree graph in a single read pass:
//   - ESM: import ... from 'path'
//   - CommonJS: require('path')
//   - Dynamic: import('path')
//   - Python: from module import ... / import module
// We only capture the module specifier (the string after from/require/import).
const IMPORT = /(?:from\s*['"]([^'"]+)['"])|(?:require\(\s*['"]([^'"]+)['"]\s*\))|(?:import\(\s*['"]([^'"]+)['"]\s*\))|(?:^\s*(?:from|import)\s+([A-Za-z0-9_.]+))/gm;

/**
 * Normalise a module specifier to a plain module name for in-degree counting.
 * We only need the final path segment, stripped of its extension, so that
 * "./model/router.ts", "../router", and "router" all map to "router" and match
 * the file at src/model/router.ts when computing its in-degree.
 */
const moduleName = (spec: string): string => (spec.split("/").pop() ?? spec).replace(CODE, "").replace(/\.[^.]+$/, "");

/**
 * Build and return the repo map string, capped to `budget` tokens.
 *
 * Each included file contributes a block of the form:
 *
 *   path/to/file.ts
 *     export function foo(...)
 *     export class Bar
 *     ...
 *
 * Files are ranked by import in-degree before the budget cap is applied, so
 * the most structurally important modules appear first. `modelId` calibrates
 * the token counting to the answering model — without it the default safe
 * over-estimate (1.35x) under-fills the map for non-Anthropic models.
 */
export function repoMap(cwd = process.cwd(), budget = 4000, modelId?: string): string {
  const files = listProjectFiles(cwd).filter((f) => CODE.test(f));

  // Single read pass per file: extract both signature lines and import targets.
  // Combining the two loops avoids reading each file twice.
  const parsed: { file: string; sigs: string[]; imports: Set<string> }[] = [];
  for (const f of files) {
    let src: string;
    try {
      src = readFileSync(resolve(cwd, f), "utf8");
    } catch {
      continue;
    }

    // Collect lines that match the signature pattern, indent them for display.
    const sigs = src
      .split("\n")
      .filter((l) => SIG.test(l))
      .map((l) => "  " + l.replace(/\s*\{?\s*$/, "").trim());

    // Files with no recognisable declarations add no value to the map.
    if (!sigs.length) continue;

    // Collect the set of module names this file imports. Using a Set deduplicates
    // repeated imports of the same module so each import counts once per file.
    const imports = new Set<string>();
    for (const m of src.matchAll(IMPORT)) {
      const spec = m[1] ?? m[2] ?? m[3] ?? m[4];
      if (spec) imports.add(moduleName(spec));
    }
    parsed.push({ file: f, sigs, imports });
  }

  // Build the in-degree map: for each module name, count how many distinct
  // files import it. A high count means many files depend on that module.
  const inDegree = new Map<string, number>();
  for (const p of parsed) for (const name of p.imports) inDegree.set(name, (inDegree.get(name) ?? 0) + 1);

  // scoreOf maps a file path to its in-degree using the same normalisation as
  // moduleName, so "src/model/router.ts" looks up "router" in the map.
  const scoreOf = (file: string): number => inDegree.get(moduleName(file)) ?? 0;

  // Sort: src/ first, then by descending in-degree, then alphabetically.
  parsed.sort(
    (a, b) =>
      Number(b.file.startsWith("src/")) - Number(a.file.startsWith("src/")) ||
      scoreOf(b.file) - scoreOf(a.file) ||
      a.file.localeCompare(b.file),
  );

  // Greedily pack files into the budget. The first file is always included even
  // if it alone exceeds the budget, so the map is never completely empty.
  const blocks: string[] = [];
  let used = 0;
  for (const p of parsed) {
    const block = `${p.file}\n${p.sigs.join("\n")}`;
    const cost = countTokens(block, modelId);
    if (used + cost > budget) {
      if (!blocks.length) blocks.push(block); // guarantee at least one entry
      break;
    }
    blocks.push(block);
    used += cost;
  }
  return blocks.join("\n");
}
