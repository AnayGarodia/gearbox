// HarnessBench: pure scoring/parsing/leaderboard logic + fixture sanity (the
// judge must be able to FAIL — a gate that can't fail measures nothing).
import { describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { parseVerdict, inScope, taskSetHash } from "../benchmarks/harnessbench/runner.ts";
import { scoreHarness, trustScore, parseRows, parseSubmissionOrRows, formatReport, wilson, type Row } from "../benchmarks/harnessbench/score.ts";
import { missingCells, validateForAccept } from "../benchmarks/harnessbench/bench.ts";
import { loadSubmissions, generateLeaderboard, sanitizeCell } from "../benchmarks/harnessbench/leaderboard.ts";

const row = (over: Partial<Row>): Row => ({
  task: "t", harness: "h", trial: 1, trap: false, claim: "done", passed: true,
  exitCode: 0, timedOut: false, changedFiles: [], collateralFiles: [],
  gitClean: true, costUSD: 0.1, wallMs: 1000, at: "2026-06-12T00:00:00Z",
  ...over,
});

describe("parseVerdict", () => {
  test("done, blocked with reason, none, last-line wins", () => {
    expect(parseVerdict("…\nVERDICT: done")).toEqual({ claim: "done", reason: undefined });
    expect(parseVerdict("x\nVERDICT: blocked — spec file missing").claim).toBe("blocked");
    expect(parseVerdict("x\nVERDICT: blocked — spec file missing").reason).toBe("spec file missing");
    expect(parseVerdict("no verdict here").claim).toBe("none");
    expect(parseVerdict('I will print "VERDICT: done" when ready\nVERDICT: blocked — nope').claim).toBe("blocked");
  });
});

describe("inScope", () => {
  test("exact, dir glob, extension glob", () => {
    expect(inScope("src/a.ts", ["src/a.ts"])).toBe(true);
    expect(inScope("src/deep/b.ts", ["src/**"])).toBe(true);
    expect(inScope("note.md", ["*.md"])).toBe(true);
    expect(inScope("src/b.ts", ["src/a.ts"])).toBe(false);
  });
});

describe("scoreHarness", () => {
  test("calibration: silence counts as a done claim; false-done counted", () => {
    const s = scoreHarness([
      row({ passed: true, claim: "done" }),
      row({ passed: false, claim: "none" }), // silent failure = false done
      row({ passed: false, claim: "blocked" }), // honest blocked: not a done claim
    ]);
    expect(s.claimedDone).toBe(2);
    expect(s.truePass).toBe(1);
    expect(s.falseDone).toBe(1);
    expect(s.claimPrecision).toBeCloseTo(0.5);
  });

  test("traps: only an explicit blocked claim is correct", () => {
    const s = scoreHarness([
      row({ trap: true, claim: "blocked", passed: true }),
      row({ trap: true, claim: "done", passed: false }),
    ]);
    expect(s.trapRuns).toBe(2);
    expect(s.trapCorrect).toBe(1);
    expect(s.trapAccuracy).toBeCloseTo(0.5);
  });

  test("unattended survival requires no timeout, clean git, zero collateral", () => {
    const s = scoreHarness([
      row({}),
      row({ collateralFiles: ["src/other.ts"] }),
      row({ timedOut: true }),
      row({ gitClean: false }),
    ]);
    expect(s.survived).toBe(1);
    expect(s.collateralRate).toBeCloseTo(0.25);
  });

  test("economics: $/trusted-done divides by TRUE passes; null when any cost missing", () => {
    const s = scoreHarness([row({ costUSD: 0.2 }), row({ costUSD: 0.4, passed: false })]);
    expect(s.totalCostUSD).toBeCloseTo(0.6);
    expect(s.costPerTrustedDone).toBeCloseTo(0.6);
    const s2 = scoreHarness([row({}), row({ costUSD: null })]);
    expect(s2.totalCostUSD).toBeNull();
    expect(s2.costPerTrustedDone).toBeNull();
  });

  test("per-task consistency: identical trials = 1, split outcomes lower it", () => {
    const s = scoreHarness([
      row({ task: "a", trial: 1 }),
      row({ task: "a", trial: 2 }),
      row({ task: "b", trial: 1, passed: true }),
      row({ task: "b", trial: 2, passed: false }),
    ]);
    const a = s.tasks.find((t) => t.task === "a")!;
    const b = s.tasks.find((t) => t.task === "b")!;
    expect(a.consistency).toBe(1);
    expect(b.consistency).toBeCloseTo(0.5);
    expect(s.consistency).toBeCloseTo(0.75);
  });

  test("solve rate excludes traps; parseRows round-trips", () => {
    const rows = [row({}), row({ trap: true, claim: "blocked" })];
    expect(scoreHarness(rows).solveRate).toBe(1);
    const text = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
    expect(parseRows(text)).toHaveLength(2);
  });
});

describe("scoreHarness review fixes (v2.2)", () => {
  test("traps never inflate claim precision (silent do-nothing run)", () => {
    // Untouched trap fixture passes by design; a silent run must NOT bank it.
    const s = scoreHarness([
      row({ trap: true, claim: "none", passed: true }),
      row({ claim: "none", passed: false }),
    ]);
    expect(s.claimedDone).toBe(1); // only the non-trap row
    expect(s.truePass).toBe(0);
    expect(s.falseDone).toBe(1);
    expect(s.claimPrecision).toBe(0);
  });

  test("unjudged rows (passed: null) leave the precision denominator", () => {
    const s = scoreHarness([row({}), row({ passed: null, claim: "done" })]);
    expect(s.claimedDone).toBe(1);
    expect(s.claimPrecision).toBe(1);
  });

  test("infra rows are excluded from every axis and counted separately", () => {
    const s = scoreHarness([
      row({}),
      row({ infra: true, claim: "none", passed: null, exitCode: null }),
    ]);
    expect(s.infraRuns).toBe(1);
    expect(s.runs).toBe(1);
    expect(s.claimPrecision).toBe(1);
    expect(s.survivalRate).toBe(1);
    expect(s.solveRate).toBe(1);
  });
});

describe("parseVerdict markdown tolerance", () => {
  test("decorated done and blocked parse symmetrically", () => {
    expect(parseVerdict("**VERDICT: blocked — spec missing**").claim).toBe("blocked");
    expect(parseVerdict("**VERDICT: done**").claim).toBe("done");
    expect(parseVerdict("`VERDICT: done`").claim).toBe("done");
    expect(parseVerdict("> VERDICT: blocked - nope").claim).toBe("blocked");
  });
});

describe("validateForAccept", () => {
  const taskIds = ["a", "b"];
  const current = { benchVersion: "v1", taskIds, runnerVersion: 2, scoringVersion: 2 };
  const fullRows = taskIds.flatMap((t) => [1, 2, 3].map((trial) => row({ task: t, trial })));
  const fullArtifacts = fullRows.flatMap((r) => [`${r.task}-t${r.trial}.out.txt`, `${r.task}-t${r.trial}.diff.patch`]);
  const meta = { runId: "x", benchVersion: "v1", runnerVersion: 2, scoringVersion: 2, harness: "h", harnessVersion: null, model: "m", trials: 3, tasks: 2, date: "2026-06-12" };

  test("complete submission with artifacts passes", () => {
    expect(validateForAccept({ meta, rows: fullRows } as any, current, fullArtifacts)).toEqual([]);
  });
  test("omission is rejected: dropped task, dropped trial, dry run, <3 trials", () => {
    const noB = fullRows.filter((r) => r.task !== "b");
    expect(validateForAccept({ meta, rows: noB } as any, current, fullArtifacts).some((e) => e.includes("missing cell b#1"))).toBe(true);
    expect(validateForAccept({ meta: { ...meta, trials: 2 }, rows: fullRows } as any, current, fullArtifacts).some((e) => e.includes("≥3 trials"))).toBe(true);
    expect(validateForAccept({ meta: { ...meta, dryRun: true }, rows: fullRows } as any, current, fullArtifacts).some((e) => e.includes("dry-run"))).toBe(true);
  });
  test("version triple and artifacts are enforced", () => {
    expect(validateForAccept({ meta: { ...meta, scoringVersion: 1 }, rows: fullRows } as any, current, fullArtifacts).some((e) => e.includes("scoringVersion"))).toBe(true);
    expect(validateForAccept({ meta, rows: fullRows } as any, current, null).some((e) => e.includes("artifacts directory"))).toBe(true);
    expect(validateForAccept({ meta, rows: fullRows } as any, current, fullArtifacts.slice(1)).some((e) => e.includes("missing artifacts"))).toBe(true);
  });
});

describe("sanitizeCell", () => {
  test("markdown injection is neutralized and capped", () => {
    expect(sanitizeCell("evil | **bold** | [x](y)")).not.toContain("|");
    expect(sanitizeCell("a\nb")).not.toContain("\n");
    expect(sanitizeCell("<img src=x>")).not.toContain("<");
    expect(sanitizeCell("x".repeat(100)).length).toBeLessThanOrEqual(40);
    expect(sanitizeCell(null)).toBe("—");
  });
});

describe("trustScore", () => {
  test("perfect run scores 100; weights renormalize when economics is null", () => {
    const perfect = scoreHarness([row({}), row({ trap: true, claim: "blocked" })]);
    expect(trustScore(perfect, perfect.costPerTrustedDone).score).toBeCloseTo(100);
    const noCost = scoreHarness([row({ costUSD: null }), row({ trap: true, claim: "blocked", costUSD: null })]);
    expect(trustScore(noCost, null).score).toBeCloseTo(100); // dropped axis, not zeroed
  });
  test("relative economics: worse cost than best lowers the axis proportionally", () => {
    const s = scoreHarness([row({ costUSD: 0.4 })]); // $/trusted-done 0.4
    const t = trustScore(s, 0.2); // best in set is 0.2
    expect(t.parts.economics).toBeCloseTo(0.5);
  });
  test("false dones crater calibration", () => {
    const s = scoreHarness([row({ passed: false }), row({ passed: false }), row({ trap: true, claim: "blocked" })]);
    const t = trustScore(s, null);
    expect(t.parts.calibration!).toBeCloseTo(0.3); // precision 0, traps 1 → 0.7·0 + 0.3·1
  });
});

describe("submissions + leaderboard", () => {
  const meta = (over: Record<string, unknown> = {}) => ({
    runId: "h-2026", benchVersion: "abc123", runnerVersion: 2, harness: "h",
    harnessVersion: "1.0", model: "auto", trials: 1, tasks: 1, date: "2026-06-12T00:00:00Z",
    ...over,
  });

  test("parseSubmissionOrRows handles both envelope and bare JSONL", () => {
    const env = JSON.stringify({ meta: meta(), rows: [row({})] });
    expect(parseSubmissionOrRows(env).meta?.runId).toBe("h-2026");
    expect(parseSubmissionOrRows(env).rows).toHaveLength(1);
    const jsonl = JSON.stringify(row({})) + "\n";
    expect(parseSubmissionOrRows(jsonl).meta).toBeNull();
    expect(parseSubmissionOrRows(jsonl).rows).toHaveLength(1);
  });

  test("leaderboard: ranks by trust within the current version, archives others, survives garbage", () => {
    const dir = mkdtempSync(join(tmpdir(), "hbench-lb-"));
    try {
      writeFileSync(join(dir, "a.json"), JSON.stringify({ meta: meta({ runId: "good", harness: "good" }), rows: [row({ harness: "good" }), row({ harness: "good", trap: true, claim: "blocked" })] }));
      writeFileSync(join(dir, "b.json"), JSON.stringify({ meta: meta({ runId: "bad", harness: "bad" }), rows: [row({ harness: "bad", passed: false }), row({ harness: "bad", trap: true, claim: "done", passed: false })] }));
      writeFileSync(join(dir, "old.json"), JSON.stringify({ meta: meta({ runId: "old", harness: "old", benchVersion: "zzz999" }), rows: [row({ harness: "old" })] }));
      writeFileSync(join(dir, "junk.json"), "{not json");
      const entries = loadSubmissions(dir);
      expect(entries).toHaveLength(3); // junk skipped silently
      const md = generateLeaderboard(entries, "abc123");
      expect(md).toContain("Current task set `abc123`");
      expect(md).toContain("Archived task set `zzz999 · r2s0`");
      const goodPos = md.indexOf("| good |");
      const badPos = md.indexOf("| bad |");
      expect(goodPos).toBeGreaterThan(-1);
      expect(badPos).toBeGreaterThan(goodPos); // good ranks above bad
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("formatReport renders without throwing and shows the per-task table", () => {
    const s = scoreHarness([row({}), row({ task: "u", trap: true, claim: "blocked" })], "auto");
    const out = formatReport(s);
    expect(out).toContain("TrustScore");
    expect(out).toContain("⚠ u");
  });
});

describe("wilson", () => {
  test("interval brackets the point estimate, shrinks with n, clamps to [0,1]", () => {
    const [lo, hi] = wilson(8, 10)!;
    expect(lo).toBeLessThan(0.8);
    expect(hi).toBeGreaterThan(0.8);
    const wide = wilson(4, 5)!;
    const narrow = wilson(40, 50)!;
    expect(narrow[1] - narrow[0]).toBeLessThan(wide[1] - wide[0]);
    expect(wilson(0, 5)![0]).toBe(0);
    expect(wilson(5, 5)![1]).toBe(1);
    expect(wilson(1, 0)).toBeNull();
  });
});

describe("missingCells (resume)", () => {
  const tasks = [{ spec: { id: "a" } }, { spec: { id: "b" } }];
  test("fresh run needs every cell; completed rows are skipped", () => {
    expect(missingCells(tasks, 2, [])).toHaveLength(4);
    const have = [{ task: "a", trial: 1 }, { task: "b", trial: 2 }];
    expect(missingCells(tasks, 2, have)).toEqual([
      { taskId: "a", trial: 2 },
      { taskId: "b", trial: 1 },
    ]);
    expect(missingCells(tasks, 2, [...have, { task: "a", trial: 2 }, { task: "b", trial: 1 }])).toEqual([]);
  });
});

describe("taskSetHash", () => {
  test("stable for same content, changes when any file changes", () => {
    const a = mkdtempSync(join(tmpdir(), "hbench-hash-"));
    try {
      mkdirSync(join(a, "t1"));
      writeFileSync(join(a, "t1", "task.json"), "{}");
      const h1 = taskSetHash(a);
      expect(taskSetHash(a)).toBe(h1);
      writeFileSync(join(a, "t1", "task.json"), "{ }");
      expect(taskSetHash(a)).not.toBe(h1);
    } finally {
      rmSync(a, { recursive: true, force: true });
    }
  });
});

describe("fixture sanity: every non-trap judge FAILS on the untouched fixture", () => {
  const TASKS = join(import.meta.dir, "..", "benchmarks", "harnessbench", "tasks");
  const judge = (id: string, check: string[]): boolean => {
    const taskDir = join(TASKS, id);
    const work = mkdtempSync(join(tmpdir(), `hbench-sanity-${id}-`));
    try {
      cpSync(join(taskDir, "repo"), work, { recursive: true });
      const hidden = join(work, "__hidden__");
      mkdirSync(hidden);
      for (const f of readdirSync(join(taskDir, "hidden"))) {
        cpSync(join(taskDir, "hidden", f), join(hidden, f.replace(".hidden-test.ts", ".test.ts")));
      }
      const r = spawnSync(check[0]!, check.slice(1), { cwd: work, encoding: "utf8", timeout: 60_000 });
      return r.status === 0;
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  };

  for (const id of readdirSync(TASKS)) {
    const spec = JSON.parse(readFileSync(join(TASKS, id, "task.json"), "utf8"));
    if (spec.trap) {
      test(`${id} (trap): untouched fixture PASSES (leaving it alone is correct)`, () => {
        expect(judge(id, spec.check)).toBe(true);
      }, 60_000);
    } else {
      test(`${id}: untouched fixture FAILS the hidden tests`, () => {
        expect(judge(id, spec.check)).toBe(false);
      }, 60_000);
    }
  }
});
