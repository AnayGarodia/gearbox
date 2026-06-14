// T1: measure the FREE keyword task-judge against the labeled corpus.
// Reports overall accuracy, a confusion matrix, and the two error rates that
// actually matter for routing safety:
//   - DANGEROUS: a hard task (code/plan, bar 0.7) misread as something cheaper
//     → real work routed to a weak model. This is the costly error.
//   - WASTEFUL:  an easy task misread as hard → a little money wasted, never a
//     quality loss. Tolerable, and the safe direction under ambiguity.
// `floor` rows (genuinely ambiguous) count toward DANGEROUS only if the judge
// undershoots the safe bar; their exact label is not required.
//
// Run: bun run experiments/routing/classify-bench.ts
import { classify } from "../../src/model/router.ts";
import { CORPUS, BAR, type Kind, type LabeledPrompt } from "./classify-corpus.ts";

const KINDS: Kind[] = ["summarize", "classify", "search", "chat", "plan", "code"];

interface Row extends LabeledPrompt {
  got: Kind;
  exact: boolean;
  dangerous: boolean; // routed below the expected bar (hard → cheap)
  wasteful: boolean; // routed above the needed bar (easy → expensive)
}

function evaluate(): Row[] {
  return CORPUS.map((c) => {
    const got = classify(c.prompt) as Kind;
    const exact = got === c.expected;
    const dangerous = BAR[got] < BAR[c.expected]; // undershot the safe bar
    const wasteful = BAR[got] > BAR[c.expected];
    return { ...c, got, exact, dangerous, wasteful };
  });
}

function pct(n: number, d: number): string {
  return d === 0 ? "—" : `${((100 * n) / d).toFixed(1)}%`;
}

function report(rows: Row[]): void {
  const n = rows.length;
  const exact = rows.filter((r) => r.exact).length;
  // Exact-accuracy excluding floor rows (where exact isn't required).
  const strict = rows.filter((r) => !r.floor);
  const strictExact = strict.filter((r) => r.exact).length;
  const dangerous = rows.filter((r) => r.dangerous);
  const wasteful = rows.filter((r) => r.wasteful);

  console.log(`\n=== Keyword task-judge — ${n} prompts ===`);
  console.log(`Exact kind match:        ${exact}/${n}  (${pct(exact, n)})`);
  console.log(`Exact (excl. ambiguous): ${strictExact}/${strict.length}  (${pct(strictExact, strict.length)})`);
  console.log(`DANGEROUS (hard→cheap):  ${dangerous.length}/${n}  (${pct(dangerous.length, n)})   <- the error that matters`);
  console.log(`WASTEFUL  (easy→costly): ${wasteful.length}/${n}  (${pct(wasteful.length, n)})`);

  // Confusion matrix: expected (rows) × got (cols).
  console.log(`\nConfusion (expected ↓ / got →):`);
  const head = "expected".padEnd(11) + KINDS.map((k) => k.slice(0, 5).padStart(7)).join("");
  console.log(head);
  for (const exp of KINDS) {
    const line = KINDS.map((g) => {
      const c = rows.filter((r) => r.expected === exp && r.got === g).length;
      return (c || "·").toString().padStart(7);
    }).join("");
    console.log(exp.padEnd(11) + line);
  }

  if (dangerous.length) {
    console.log(`\n--- DANGEROUS misroutes (hard task → cheap model) ---`);
    for (const r of dangerous) console.log(`  [${r.expected}→${r.got}] ${r.prompt}`);
  }
  const wrongNotDangerous = rows.filter((r) => !r.exact && !r.dangerous && !r.floor);
  if (wrongNotDangerous.length) {
    console.log(`\n--- Wasteful / off-label (safe direction) ---`);
    for (const r of wrongNotDangerous) console.log(`  [${r.expected}→${r.got}] ${r.prompt}`);
  }
  console.log("");
}

report(evaluate());
