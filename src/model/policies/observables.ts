// observables policy — difficulty from repo-side signals, no classifier call.
// The baseline pays a billed 1–2s LLM hop to classify ambiguous prompts, and
// when in doubt defaults to the expensive bar. But the repo itself predicts
// edit difficulty better than the prompt text does, for free: a concentrated
// BM25 retrieval hit means localized work (one file clearly matches), a flat
// spread across many files means diffuse cross-cutting work. This policy
// derives kind and bar from those signals (src/context/retrieve.ts
// difficultySignals) and never makes a classify call.
import { RoutingSelector, BAR_MAX, confidentKeywordKind } from "../router.ts";
import { difficultySignals } from "../../context/retrieve.ts";
import type { Task, ModelChoice, Scorecard, DifficultySignals } from "../selector.ts";

type Kind = NonNullable<Task["kind"]>;

// Bin thresholds — monotone heuristics, deliberately coarse until the outcome
// log accumulates enough (signals → verify outcome) pairs to fit them.
const CONCENTRATED_SPREAD = 2.5; // top hit ≥2.5× the mean of the top 8
const DIFFUSE_SPREAD = 1.4;
const SMALL_MATCH = 40; // files matched
const LARGE_MATCH = 120;
const SHORT_PROMPT = 400; // chars
const LONG_PROMPT = 1500;

/** Kind for an ambiguous prompt (no confident keyword): a short prompt whose
 *  retrieval is concentrated on a specific spot reads as a question about that
 *  spot → chat; anything diffuse or long is treated as real work → code. */
export function kindFromSignals(d: DifficultySignals): Kind {
  return d.retrievalSpread >= 2.0 && d.promptChars < 300 ? "chat" : "code";
}

// Below this many matched files, a "low spread" reading is NOT evidence of
// diffuse work — a one- or two-file workspace trivially has top≈mean and so a
// near-1.0 spread. The routing bench surfaced this: single-file fixture tasks
// were misread as diffuse and over-routed to the strong model. The diffuse
// signal therefore requires either genuinely many matched files OR a long
// prompt; a low spread alone only counts once enough files are in play.
const MIN_FILES_FOR_DIFFUSE = 4;

/** Difficulty-adjusted bar for code/plan work. Exported for the combined policy. */
export function difficultyBar(base: number, d: DifficultySignals): number {
  const concentrated = d.retrievalSpread >= CONCENTRATED_SPREAD && d.filesMatched <= SMALL_MATCH && d.promptChars <= SHORT_PROMPT;
  const lowSpreadDiffuse = d.filesMatched >= MIN_FILES_FOR_DIFFUSE && d.retrievalSpread > 0 && d.retrievalSpread < DIFFUSE_SPREAD;
  const diffuse = lowSpreadDiffuse || d.filesMatched > LARGE_MATCH || d.promptChars > LONG_PROMPT;
  // Localized + small: a Haiku/Flash-class model handles it, and with tests it
  // can be even cheaper. Diffuse: demand more than the static bar.
  if (concentrated) return d.hasTests ? 0.45 : 0.6;
  if (diffuse) return Math.min(BAR_MAX, base + 0.1);
  return base;
}

/** Fill kind + difficulty from repo observables when the caller didn't.
 *  Exported for the combined policy and the headless runner. */
export function enrichWithObservables(task: Task): Task {
  const difficulty = task.difficulty ?? difficultySignals(task.prompt, process.cwd(), task.verifierTier === "tests");
  const kind = task.kind ?? confidentKeywordKind(task.prompt) ?? kindFromSignals(difficulty);
  return { ...task, kind, difficulty };
}

export class ObservablesSelector extends RoutingSelector {
  override readonly policyName: string = "observables";
  /** The runner skips the LLM classify hop for selectors that classify themselves. */
  readonly classifiesItself = true;

  protected override barFor(kind: Kind, escalate: number, task: Task): number {
    const base = super.barFor(kind, escalate, task);
    if (escalate > 0 || (kind !== "code" && kind !== "plan") || !task.difficulty) return base;
    return difficultyBar(base, task.difficulty);
  }

  override select(task: Task): ModelChoice {
    return super.select(enrichWithObservables(task));
  }

  override explain(task: Task): Scorecard {
    return super.explain(enrichWithObservables(task));
  }
}
