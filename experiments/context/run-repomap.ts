// E-D (offline/token side) — how many tokens does it take to give a model enough
// codebase awareness to make a correct cross-file change? Compares, on the REAL
// gearbox src/: (a) full-file dump of every source file, (b) a structural
// signature map (exports / function / class / interface / type signatures —
// Aider-style, but regex-extracted here as a proxy for tree-sitter), and (c)
// ripgrep snippets for one symbol. Token correctness (does the model edit right?)
// is the live half — see run-recall.ts; this measures EFFICIENCY.
// Run: bun run experiments/context/run-repomap.ts
import { countTokens } from "../switch-cost/cost.ts";
import { readFileSync } from "node:fs";

const files = (() => {
  const p = Bun.spawnSync(["git", "ls-files", "src"], { cwd: `${import.meta.dir}/../..`, stdout: "pipe" });
  return p.stdout.toString().split("\n").filter((f) => /\.(ts|tsx)$/.test(f));
})();
const root = `${import.meta.dir}/../..`;
const read = (f: string) => {
  try {
    return readFileSync(`${root}/${f}`, "utf8");
  } catch {
    return "";
  }
};

// (a) full dump
const fullDump = files.map((f) => `// ${f}\n${read(f)}`).join("\n\n");

// (b) structural signature map — the lines that define the codebase's shape
const SIG = /^\s*(export\s+)?(async\s+)?(function|class|interface|type|const|enum)\s+[A-Za-z0-9_]+|^\s*export\s+(default\s+)?(function|class)/;
function signatures(src: string): string[] {
  return src
    .split("\n")
    .filter((l) => SIG.test(l))
    .map((l) => l.replace(/\s*\{?\s*$/, "").replace(/=\s*$/, "=").trim());
}
const sigMap = files
  .map((f) => {
    const sigs = signatures(read(f));
    return sigs.length ? `${f}\n${sigs.map((s) => "  " + s).join("\n")}` : "";
  })
  .filter(Boolean)
  .join("\n");

// (c) ripgrep snippets for a representative symbol used across files
const rg = Bun.which("rg");
const grepSnips = rg
  ? Bun.spawnSync([rg, "--line-number", "--no-heading", "-C", "2", "ModelSpec", `${root}/src`], { stdout: "pipe" }).stdout.toString()
  : "(rg unavailable)";

const tDump = countTokens(fullDump);
const tMap = countTokens(sigMap);
const tGrep = countTokens(grepSnips);

console.log("\nE-D · codebase-awareness token efficiency (real gearbox src/)\n");
console.log(`files in src/: ${files.length}`);
console.log("─────────────────────────────────────────────────────────────");
console.log(`(a) full-file dump      : ${tDump.toLocaleString().padStart(8)} tok   (whole codebase, exhaustive)`);
console.log(`(b) signature map       : ${tMap.toLocaleString().padStart(8)} tok   (whole-repo awareness, structural)`);
console.log(`(c) ripgrep "ModelSpec" : ${tGrep.toLocaleString().padStart(8)} tok   (precise, one symbol, no structure)`);
console.log("─────────────────────────────────────────────────────────────");
console.log(`signature map vs full dump: ${(tDump / tMap).toFixed(1)}× smaller, for whole-repo awareness`);
console.log(`map is ${((tMap / 200_000) * 100).toFixed(1)}% of a 200k window vs ${((tDump / 200_000) * 100).toFixed(0)}% for the full dump\n`);
console.log("Takeaway: a structural map gives whole-repo awareness for a fraction of the tokens;");
console.log("grep is the precise on-demand arm. Lead with the map, retrieve files on demand.\n");
