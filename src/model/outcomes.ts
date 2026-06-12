// Routing-outcome log — the joined record the priors flywheel was missing.
// priors.json stores only aggregate counts per (repo, kind, model); this log
// keeps each outcome WITH the task's retrieval terms and touched files, so the
// precedent policy can route by nearest verified neighbor ("the last five
// tasks that looked like this passed on deepseek HERE") instead of the coarse
// 6-kind taxonomy. Append-only JSONL beside priors.json; same crash tolerance
// philosophy (best-effort, never throws into a turn).
import { appendFileSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { repoSlug, type Outcome } from "./priors.ts";

export interface RoutingOutcome {
  at: number;
  repo: string;
  kind: string;
  modelId: string;
  outcome: Outcome;
  promptHash: string; // sha256 prefix — dedupe/debug without storing raw prompts
  terms: string[]; // BM25 retrieval terms of the prompt (retrieve.ts terms())
  touched: string[]; // files the turn changed
  proofTier?: string; // what the verifier could prove (tests | types | none)
  policy?: string; // which routing policy made the pick (experiment provenance)
  costUSD?: number;
}

function home(): string {
  return process.env.GEARBOX_HOME || join(homedir(), ".gearbox");
}
const file = () => join(home(), "routing-outcomes.jsonl");

const MAX_TERMS = 32; // enough for similarity; keeps lines bounded
const MAX_TOUCHED = 16;

export function recordRoutingOutcome(o: Omit<RoutingOutcome, "at" | "repo" | "promptHash"> & { prompt: string; repo?: string }): void {
  try {
    mkdirSync(home(), { recursive: true });
    const { prompt, ...rest } = o;
    const rec: RoutingOutcome = {
      at: Date.now(),
      repo: o.repo ?? repoSlug(),
      ...rest,
      promptHash: createHash("sha256").update(prompt).digest("hex").slice(0, 16),
      terms: o.terms.slice(0, MAX_TERMS),
      touched: o.touched.slice(0, MAX_TOUCHED),
    };
    appendFileSync(file(), JSON.stringify(rec) + "\n", { mode: 0o600 });
    cache = null; // next read sees the new record
  } catch {
    /* best-effort: outcome logging must never break a turn */
  }
}

let cache: { at: number; rows: RoutingOutcome[] } | null = null;
const TTL = 10_000;
const MAX_ROWS = 2000; // precedent only needs recent history; bound memory

/** All recorded outcomes for a repo, oldest first. Cached briefly; tolerant of
 *  a missing or partially-torn file (bad lines are skipped). */
export function readRoutingOutcomes(repo?: string): RoutingOutcome[] {
  const slug = repo ?? repoSlug();
  const now = Date.now();
  if (!cache || now - cache.at > TTL) {
    const rows: RoutingOutcome[] = [];
    try {
      for (const line of readFileSync(file(), "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const r = JSON.parse(line);
          if (r && typeof r.at === "number" && r.kind && r.modelId) rows.push(r);
        } catch {
          /* torn tail line — skip */
        }
      }
    } catch {
      /* none yet */
    }
    cache = { at: now, rows: rows.slice(-MAX_ROWS) };
  }
  return cache.rows.filter((r) => r.repo === slug);
}

/** Test hook. */
export function clearOutcomesCache(): void {
  cache = null;
}
