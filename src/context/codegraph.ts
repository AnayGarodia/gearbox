// Static code graph for retrieval. It captures definitions, imports, references,
// and dependency edges without requiring an LSP server; retrieval can use it as
// a semantic proximity signal above plain BM25.
import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { listProjectFiles } from "../ui/files.ts";

const CODE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|c|h|cpp|hpp)$/;
const DEF_RE = /\b(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|const|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/g;
const REF_RE = /\b([A-Za-z_][A-Za-z0-9_]*)\s*(?:\(|<)/g;
const IMPORT_RE = /(?:from\s*['"]([^'"]+)['"])|(?:require\(\s*['"]([^'"]+)['"]\s*\))|(?:import\(\s*['"]([^'"]+)['"]\s*\))/gm;

export interface CodeGraphFile {
  file: string;
  defs: string[];
  refs: string[];
  imports: string[];
  importedFiles: string[];
  importers: string[];
}

export interface CodeGraph {
  files: Map<string, CodeGraphFile>;
  symbolDefs: Map<string, string[]>;
}

let cached: { cwd: string; graph: CodeGraph } | null = null;

const pathKey = (f: string) => f.replace(/\\/g, "/").replace(CODE, "").replace(/\.[^.]+$/, "");
const moduleName = (spec: string): string => (spec.split("/").pop() ?? spec).replace(CODE, "").replace(/\.[^.]+$/, "");

function resolveImport(spec: string, fromFile: string, cwd: string, fileSet: Set<string>): string | null {
  if (!spec.startsWith(".")) return null;
  const abs = resolve(cwd, dirname(fromFile), spec);
  const rel = relative(cwd, abs).replace(/\\/g, "/");
  const candidates = [rel, `${rel}.ts`, `${rel}.tsx`, `${rel}.js`, `${rel}.jsx`, `${rel}/index.ts`, `${rel}/index.tsx`];
  return candidates.find((c) => fileSet.has(c)) ?? null;
}

export function resetCodeGraph(): void {
  cached = null;
}

export function codeGraph(cwd = process.cwd()): CodeGraph {
  if (cached?.cwd === cwd) return cached.graph;
  const files = listProjectFiles(cwd).filter((f) => CODE.test(f));
  const fileSet = new Set(files);
  const graph: CodeGraph = { files: new Map(), symbolDefs: new Map() };

  for (const file of files) {
    let src = "";
    try {
      src = readFileSync(resolve(cwd, file), "utf8");
    } catch {
      continue;
    }
    const defs = [...src.matchAll(DEF_RE)].map((m) => m[1]!.toLowerCase());
    const refs = [...new Set([...src.matchAll(REF_RE)].map((m) => m[1]!.toLowerCase()))];
    const imports = [...src.matchAll(IMPORT_RE)].map((m) => m[1] ?? m[2] ?? m[3]).filter(Boolean) as string[];
    const importedFiles = imports.map((spec) => resolveImport(spec, file, cwd, fileSet)).filter((x): x is string => Boolean(x));
    graph.files.set(file, { file, defs, refs, imports, importedFiles, importers: [] });
    for (const d of defs) {
      const current = graph.symbolDefs.get(d) ?? [];
      current.push(file);
      graph.symbolDefs.set(d, current);
    }
  }

  for (const f of graph.files.values()) {
    for (const imported of f.importedFiles) {
      const target = graph.files.get(imported);
      if (target) target.importers.push(f.file);
    }
  }

  cached = { cwd, graph };
  return graph;
}

export function graphBoostForFile(queryTerms: string[], file: string, cwd = process.cwd()): number {
  const graph = codeGraph(cwd);
  const node = graph.files.get(file);
  if (!node || !queryTerms.length) return 0;
  const asksReferences = queryTerms.some((t) => ["reference", "references", "usage", "usages", "caller", "callers", "called"].includes(t));
  let boost = 0;
  for (const t of queryTerms) {
    if (node.defs.some((d) => d.includes(t))) boost += 2.5;
    if (asksReferences && node.refs.some((r) => r.includes(t))) boost += 2;
    const definingFiles = graph.symbolDefs.get(t) ?? [];
    if (definingFiles.some((d) => node.importedFiles.includes(d))) boost += 1.2;
    if (definingFiles.some((d) => graph.files.get(d)?.importers.includes(file))) boost += asksReferences ? 2 : 0.8;
    if (node.imports.some((spec) => moduleName(spec).toLowerCase().includes(t) || pathKey(spec).toLowerCase().includes(t))) boost += 1;
  }
  return boost;
}
