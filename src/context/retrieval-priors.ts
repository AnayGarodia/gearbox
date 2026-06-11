// Per-repo retrieval flywheel. Files that Gearbox injects and the agent then
// touches become more likely to be retrieved; repeated unused injections sink.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { RetrievalUseMeta } from "../session.ts";

export interface RetrievalPrior {
  file: string;
  injected: number;
  used: number;
  unused: number;
  score: number;
  lastUsedAt?: number;
  lastInjectedAt?: number;
}

interface RetrievalPriorsFile {
  projects: Record<string, { files: Record<string, RetrievalPrior> }>;
}

const root = () => process.env.GEARBOX_HOME || join(homedir(), ".gearbox");
const path = () => join(root(), "retrieval-priors.json");
const slug = (cwd = process.cwd()) => cwd.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "root";
const empty = (): RetrievalPriorsFile => ({ projects: {} });

// 10s TTL read cache (same pattern as preferences.ts/priors.ts): rankFiles
// calls retrievalPriorScore once PER FILE — without this, every routing turn
// re-read and re-parsed the priors JSON thousands of times. Keyed by the
// resolved path so a GEARBOX_HOME change (tests) never serves stale data;
// every write refreshes it.
let cache: { f: RetrievalPriorsFile; at: number; path: string } | null = null;
const TTL = 10_000;

function load(): RetrievalPriorsFile {
  const now = Date.now();
  const p = path();
  if (cache && cache.path === p && now - cache.at <= TTL) return cache.f;
  let f: RetrievalPriorsFile;
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    f = parsed && typeof parsed === "object" && parsed.projects ? parsed as RetrievalPriorsFile : empty();
  } catch {
    f = empty();
  }
  cache = { f, at: now, path: p };
  return f;
}

function save(data: RetrievalPriorsFile): void {
  try {
    mkdirSync(root(), { recursive: true });
    const p = path();
    writeFileSync(`${p}.tmp`, JSON.stringify(data));
    renameSync(`${p}.tmp`, p);
  } catch {
    /* best-effort; retrieval still works without priors */
  }
  cache = { f: data, at: Date.now(), path: path() };
}

function recompute(p: RetrievalPrior): RetrievalPrior {
  const total = Math.max(1, p.injected);
  const precision = p.used / total;
  const waste = p.unused / total;
  // "Unused" is a NOISY negative (the model can use injected content without
  // re-touching the file), so waste sinks gently while real use lifts harder;
  // the floor keeps even a chronic miss from blacklisting a file outright.
  const score = Math.max(-1.5, Math.min(3, precision * 3 - waste * 1.0 + Math.log1p(p.used) * 0.25));
  return { ...p, score: Number(score.toFixed(4)) };
}

export function recordRetrievalUse(meta: RetrievalUseMeta, cwd = process.cwd(), now = Date.now()): void {
  if (!meta.injected.length) return;
  const data = load();
  const key = slug(cwd);
  const project = data.projects[key] ?? { files: {} };
  const used = new Set(meta.used);
  const unused = new Set(meta.unused);
  for (const file of meta.injected) {
    const cur = project.files[file] ?? { file, injected: 0, used: 0, unused: 0, score: 0 };
    cur.injected++;
    cur.lastInjectedAt = now;
    if (used.has(file)) {
      cur.used++;
      cur.lastUsedAt = now;
    } else if (unused.has(file)) {
      cur.unused++;
    }
    project.files[file] = recompute(cur);
  }
  data.projects[key] = project;
  save(data);
}

export function retrievalPriorScore(file: string, cwd = process.cwd()): number {
  return load().projects[slug(cwd)]?.files[file]?.score ?? 0;
}

export function loadRetrievalPriors(cwd = process.cwd()): Record<string, RetrievalPrior> {
  return load().projects[slug(cwd)]?.files ?? {};
}

export function resetRetrievalPriorsForTest(): void {
  save(empty());
}
