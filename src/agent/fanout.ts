// ── PLAN FAN-OUT (PURE) ───────────────────────────────────────────────────────
// Turn a flat list of sub-tasks into ordered WAVES the harness runs one after the
// other, where every task within a wave is safe to run concurrently. Two rules
// decide the layering:
//
//   1. Dependencies — a task that declares `after: [i, j]` waits until tasks i and
//      j have completed (an earlier wave), so "run the migration" precedes "verify
//      the migration".
//   2. File conflicts — two tasks that touch the SAME file never share a wave, so
//      their isolated-worktree edits can't collide on merge. Disjoint tasks still
//      parallelize freely.
//
// This is the planning half of delegation fan-out: the model proposes independent
// chunks, this orders them into the maximally-parallel-yet-safe schedule. PURE (no
// I/O, deterministic): it takes the file/dep facts and returns wave indices, so it
// is fully fixture-testable and the executor (delegate.ts) just runs each wave.

export interface FanoutTask {
  /** Files this task will touch (lower-cased/normalized by the caller). Two tasks
   *  sharing any file are kept in different waves. Absent/empty = no conflicts. */
  files?: string[];
  /** Indices of tasks that must finish before this one starts. Out-of-range or
   *  self indices are ignored. A dependency cycle is broken best-effort. */
  after?: number[];
}

/**
 * Partition tasks into ordered waves of concurrently-safe indices.
 * - Wave order respects `after` dependencies (topological layering).
 * - Within a wave, no two tasks share a file (greedy, input-order-stable).
 * - A dependency cycle never hangs: once nothing new is "ready", the remaining
 *   tasks are emitted as a final wave (best-effort) so the schedule terminates.
 * Returns an array of waves; each wave is an array of original task indices.
 */
export function partitionIntoWaves(tasks: FanoutTask[]): number[][] {
  const n = tasks.length;
  if (n === 0) return [];
  // Normalize deps: drop self-refs and out-of-range indices.
  const deps = tasks.map((t, i) => new Set((t.after ?? []).filter((d) => d !== i && d >= 0 && d < n)));
  const fileSet = tasks.map((t) => new Set((t.files ?? []).filter(Boolean)));

  const placed = new Set<number>();
  const waves: number[][] = [];

  while (placed.size < n) {
    const remaining = [...Array(n).keys()].filter((i) => !placed.has(i));
    // Ready = all of its deps already placed.
    let ready = remaining.filter((i) => [...deps[i]!].every((d) => placed.has(d)));
    // Dependency cycle (or all-blocked): emit whatever remains so we always make
    // progress instead of looping forever.
    if (ready.length === 0) ready = remaining;

    // Greedily pack a wave from `ready` in input order, skipping a task whose
    // files clash with one already chosen this wave (it falls to the next wave).
    const wave: number[] = [];
    const waveFiles = new Set<string>();
    for (const i of ready) {
      const fs = fileSet[i]!;
      let clash = false;
      for (const f of fs) if (waveFiles.has(f)) { clash = true; break; }
      if (clash) continue;
      wave.push(i);
      for (const f of fs) waveFiles.add(f);
    }
    for (const i of wave) placed.add(i);
    waves.push(wave);
  }
  return waves;
}
