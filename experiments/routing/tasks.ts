// A realistic task stream. Distribution mirrors 2026 research: ~70% easy,
// ~20% medium, ~10% hard. Each task has a required quality bar (success iff the
// chosen model's prior for that task type >= req) and a token estimate.

import type { TaskType } from "./models.ts";

export type Task = {
  id: number;
  type: TaskType;
  req: number;       // minimum quality prior to "succeed"
  tokens: number;    // estimated total tokens (input+output) for cost
};

const REQ: Record<TaskType, number> = {
  boilerplate: 0.85, docs: 0.85, test: 0.82,
  debug: 0.86, refactor: 0.86, review: 0.86,
  architecture: 0.92, // genuinely needs a strong model
};

// deterministic pseudo-stream (no RNG: stable + reproducible)
const EASY: TaskType[] = ["boilerplate", "docs", "test"];
const MED: TaskType[] = ["debug", "refactor", "review"];
const HARD: TaskType[] = ["architecture"];

export function buildTasks(n = 100): Task[] {
  const tasks: Task[] = [];
  for (let i = 0; i < n; i++) {
    const r = i % 10; // 0-6 easy, 7-8 med, 9 hard  => 70/20/10
    const type = r <= 6 ? EASY[i % EASY.length] : r <= 8 ? MED[i % MED.length] : HARD[0];
    // token size varies: easy small, hard large
    const tokens = r <= 6 ? 3000 + (i % 5) * 1000 : r <= 8 ? 12000 + (i % 4) * 4000 : 40000 + (i % 3) * 20000;
    tasks.push({ id: i, type, req: REQ[type], tokens });
  }
  return tasks;
}
