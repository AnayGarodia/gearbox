// Route-decision log — every routed pick's scorecard, persisted. The /why
// panel already computes the full per-candidate breakdown and then throws it
// away; this keeps a compact JSONL trace so `gearbox calibrate` (and the
// routing-bench harness) can replay history offline: which candidate would
// have won under different bars/weights, realized vs estimated failure rates,
// and per-policy cost/quality. Append-only, best-effort, never throws.
import { appendFileSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { repoSlug } from "./priors.ts";

export interface RouteDecision {
  at: number;
  repo: string;
  policy: string; // which selector made the pick (baseline, thompson, …)
  kind: string;
  bar: number;
  escalate: number;
  chosen: string; // model id
  backend: "api" | "seat";
  reason: string;
  // Compact per-candidate trace: every bar-clearing candidate with its score,
  // best-first. Enough to replay "who would have won" without re-enumerating
  // accounts (which change over time).
  candidates: { id: string; score: number; quality: number }[];
}

function home(): string {
  return process.env.GEARBOX_HOME || join(homedir(), ".gearbox");
}
const file = () => join(home(), "route-log.jsonl");

const MAX_CANDIDATES = 12;

export function recordRouteDecision(d: Omit<RouteDecision, "at" | "repo">): void {
  try {
    mkdirSync(home(), { recursive: true });
    const rec: RouteDecision = { at: Date.now(), repo: repoSlug(), ...d, candidates: d.candidates.slice(0, MAX_CANDIDATES) };
    appendFileSync(file(), JSON.stringify(rec) + "\n", { mode: 0o600 });
  } catch {
    /* best-effort: the decision log must never break routing */
  }
}

/** All recorded decisions (optionally for one repo), oldest first. Tolerant of
 *  torn lines. Used by `gearbox calibrate` and the bench analyzer. */
export function readRouteDecisions(repo?: string): RouteDecision[] {
  const rows: RouteDecision[] = [];
  try {
    for (const line of readFileSync(file(), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        if (r && typeof r.at === "number" && r.chosen) rows.push(r);
      } catch {
        /* torn tail line — skip */
      }
    }
  } catch {
    /* none yet */
  }
  return repo ? rows.filter((r) => r.repo === repo) : rows;
}
