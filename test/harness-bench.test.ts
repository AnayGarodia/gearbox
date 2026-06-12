// HarnessBench pilot: pure scoring/parsing logic + fixture sanity (the judge
// must be able to FAIL — a gate that can't fail measures nothing).
import { describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { parseVerdict, inScope } from "../benchmarks/pilot/runner.ts";
import { scoreHarness, parseRows, type Row } from "../benchmarks/pilot/score.ts";

describe("parseVerdict", () => {
  test("done, blocked with reason, none, last-line wins", () => {
    expect(parseVerdict("…\nVERDICT: done")).toEqual({ claim: "done", reason: undefined });
    expect(parseVerdict("x\nVERDICT: blocked — spec file missing").claim).toBe("blocked");
    expect(parseVerdict("x\nVERDICT: blocked — spec file missing").reason).toBe("spec file missing");
    expect(parseVerdict("no verdict here").claim).toBe("none");
    // a verdict QUOTED mid-output is superseded by the actual final one
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
  const row = (over: Partial<Row>): Row => ({
    task: "t", harness: "h", trap: false, claim: "done", passed: true,
    collateralFiles: [], gitClean: true, timedOut: false, costUSD: 0.1, wallMs: 1000,
    ...over,
  });

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
    expect(s.costPerTrustedDone).toBeCloseTo(0.6); // 1 trusted done
    const s2 = scoreHarness([row({}), row({ costUSD: null })]);
    expect(s2.totalCostUSD).toBeNull();
    expect(s2.costPerTrustedDone).toBeNull();
  });

  test("solve rate excludes traps; parseRows round-trips", () => {
    const rows = [row({}), row({ trap: true, claim: "blocked" })];
    expect(scoreHarness(rows).solveRate).toBe(1);
    const text = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
    expect(parseRows(text)).toHaveLength(2);
  });
});

describe("fixture sanity: every non-trap judge FAILS on the untouched fixture", () => {
  const TASKS = join(import.meta.dir, "..", "benchmarks", "pilot", "tasks");
  const judge = (id: string): boolean => {
    const taskDir = join(TASKS, id);
    const work = mkdtempSync(join(tmpdir(), `hbench-sanity-${id}-`));
    try {
      cpSync(join(taskDir, "repo"), work, { recursive: true });
      const hidden = join(work, "__hidden__");
      mkdirSync(hidden);
      for (const f of readdirSync(join(taskDir, "hidden"))) {
        cpSync(join(taskDir, "hidden", f), join(hidden, f.replace(".hidden-test.ts", ".test.ts")));
      }
      const r = spawnSync("bun", ["test"], { cwd: work, encoding: "utf8", timeout: 60_000 });
      return r.status === 0;
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  };

  const ids = readdirSync(TASKS);
  for (const id of ids) {
    const spec = JSON.parse(readFileSync(join(TASKS, id, "task.json"), "utf8"));
    if (spec.trap) {
      test(`${id} (trap): untouched fixture PASSES (leaving it alone is correct)`, () => {
        expect(judge(id)).toBe(true);
      }, 60_000);
    } else {
      test(`${id}: untouched fixture FAILS the hidden tests`, () => {
        expect(judge(id)).toBe(false);
      }, 60_000);
    }
  }
});
