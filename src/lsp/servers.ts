// Registry of known language servers + fast project detection. Pure-ish: the
// only I/O is existsSync/readdirSync against the project root plus `which`
// lookups — and `which` is injectable so tests never touch the real PATH.
import { existsSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";
import { which } from "../proc.ts";

export type ServerId = "typescript" | "python" | "go" | "rust";
export type WhichImpl = (bin: string) => string | null;

export interface ServerSpec {
  id: ServerId;
  /** Candidate binaries, tried in order; the first one on PATH wins. */
  binaries: string[];
  /** Extra argv after the binary (e.g. --stdio). */
  args: string[];
  /** File extensions (with dot, lowercase) this server handles. */
  extensions: string[];
  /** Project marker files (relative to cwd) that indicate the language. */
  markers: string[];
  /** Fallback: any file with this extension directly in cwd also counts. */
  scanExt?: string;
}

export const SERVERS: ServerSpec[] = [
  {
    id: "typescript",
    binaries: ["typescript-language-server", "vtsls"],
    args: ["--stdio"],
    extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
    markers: ["tsconfig.json", "package.json"],
  },
  {
    id: "python",
    binaries: ["pyright-langserver", "basedpyright-langserver"],
    args: ["--stdio"],
    extensions: [".py", ".pyi"],
    markers: ["pyproject.toml", "setup.py", "requirements.txt"],
    scanExt: ".py",
  },
  { id: "go", binaries: ["gopls"], args: [], extensions: [".go"], markers: ["go.mod"] },
  { id: "rust", binaries: ["rust-analyzer"], args: [], extensions: [".rs"], markers: ["Cargo.toml"] },
];

export interface DetectedServer {
  id: ServerId;
  /** Full argv: [resolved binary path, ...args]. */
  command: string[];
  spec: ServerSpec;
}

/** Does this project (cwd) look like it uses the spec's language? */
export function projectMatches(spec: ServerSpec, cwd: string): boolean {
  for (const m of spec.markers) if (existsSync(join(cwd, m))) return true;
  if (spec.scanExt) {
    try {
      for (const f of readdirSync(cwd)) if (f.endsWith(spec.scanExt)) return true;
    } catch {
      // unreadable cwd → no match
    }
  }
  return false;
}

/**
 * Which servers are USABLE here: binary on PATH (via whichImpl) AND the
 * project matches. Shallow checks only — fast enough to run per turn.
 */
export function detectServers(cwd: string, whichImpl: WhichImpl = which): DetectedServer[] {
  const out: DetectedServer[] = [];
  for (const spec of SERVERS) {
    if (!projectMatches(spec, cwd)) continue;
    for (const bin of spec.binaries) {
      const resolved = whichImpl(bin);
      if (resolved) {
        out.push({ id: spec.id, command: [resolved, ...spec.args], spec });
        break;
      }
    }
  }
  return out;
}

/** Pick the detected server that handles this file's extension, if any. */
export function serverForFile(absPath: string, detected: DetectedServer[]): DetectedServer | null {
  const ext = extname(absPath).toLowerCase();
  return detected.find((d) => d.spec.extensions.includes(ext)) ?? null;
}

const TS_LANGUAGE_IDS: Record<string, string> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "typescriptreact",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascriptreact",
};

/** The LSP languageId to send in didOpen for this file. */
export function languageIdFor(absPath: string, id: ServerId): string {
  if (id === "typescript") return TS_LANGUAGE_IDS[extname(absPath).toLowerCase()] ?? "typescript";
  if (id === "python") return "python";
  if (id === "go") return "go";
  return "rust";
}
