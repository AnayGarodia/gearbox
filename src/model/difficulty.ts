// ── DIFFICULTY WITHIN A KIND (PURE, NON-LLM) ──────────────────────────────────
// The router's classifier gives a task's KIND (code/plan/chat/…), which sets the
// quality bar. But kind says WHAT the task is, not HOW HARD: "fix it" is the same
// kind whether it's a one-line hello-world bug or a race condition in a database
// connection pool. The prompt alone cannot tell them apart — the difficulty lives
// in the CONTEXT (which files, how big and central, this repo's track record,
// whether a test net exists to catch a cheap miss).
//
// This module turns those context signals into a difficulty score d ∈ [0,1] that
// the router adds to the bar for code/plan turns, so a hard task climbs to a
// stronger model and an easy one stays cheap — all WITHOUT a model call. It is
// deliberately pure (no I/O, no Date.now): the router gathers the signals; this
// just scores them, so it is fully fixture-testable and deterministic.
//
// Signal choice follows the empirical correlates of difficulty in coding
// benchmarks (SWE-bench): hard instances touch more files and larger hunks, and
// failure clusters by area. Every signal is optional; an absent one is NEUTRAL
// (contributes 0), never a penalty for missing data — same philosophy as the
// pure scorer (scoring.ts).

export interface DifficultySignals {
  /** A semantic read of the PROMPT itself: easy/medium/hard. The size signals
   *  below are blind to this — "fix the race condition" and "fix the typo" can
   *  have identical context size. Supplied by lexicalDifficulty (instant, free)
   *  or a cheap LLM judge. Combined by MAX with the size score, so the words can
   *  only RAISE difficulty, never drag a genuinely large task down. */
  semanticBand?: "easy" | "medium" | "hard";
  /** Working-set tokens pulled into context this turn. Bigger → more to reason over. */
  estTokens?: number;
  /** Number of files the task acts on. More files → multi-file, harder. */
  touchedFileCount?: number;
  /** Total bytes of those files. Larger code → harder to get right. */
  touchedBytes?: number;
  /** 0..1 measured code-fail rate in THIS repo (priors.ts). High → this repo is hard. */
  repoFailRate?: number;
  /** 0..1 fan-in of the touched code (LSP). High → many callers, a change ripples. */
  centrality?: number;
  /** Whether the repo has runnable verify checks. FALSE = no net to catch a cheap
   *  miss, so start more conservatively. TRUE/undefined add nothing. */
  hasTestNet?: boolean;
}

export interface Difficulty {
  /** 0..1 difficulty WITHIN the kind. */
  d: number;
  /** Human-readable contributors, for the /why scorecard. */
  reasons: string[];
}

// d=1 lifts the bar by this much. Calibrated so a maxed-out code task (base 0.7)
// reaches 0.9 — still inside the strong tier, never past the very top — while an
// easy code task stays at 0.7 where the cheapest capable model wins.
export const DIFFICULTY_BAR_RANGE = 0.2;

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

// Per-signal maximum contributions to d. They sum (then clamp), so any single
// strong signal lifts the bar a little and several together lift it a lot.
const W_CONTEXT = 0.3; // working-set size
const W_FILES = 0.2; // file count
const W_BYTES = 0.15; // total file size
const W_REPO = 0.3; // measured repo code-fail rate
const W_CENTRAL = 0.2; // fan-in of touched code
const W_NO_NET = 0.1; // conservative bump when no test net exists

// Ramp floors/ceilings: below the floor a signal is noise (0), above the ceiling
// it is fully "hard". Chosen to keep ordinary turns near 0 and only escalate on
// genuinely large/central work.
const CTX_FLOOR = 24_000, CTX_CEIL = 120_000; // tokens
const BYTES_FLOOR = 8_000, BYTES_CEIL = 80_000; // ~a small file vs a large module
const FILES_CEIL = 6; // touching ~6+ files is firmly multi-file work

const ramp = (v: number, floor: number, ceil: number) => clamp01((v - floor) / (ceil - floor));

// Band → difficulty score. `hard` = 0.85 lands a code task (base 0.7) firmly in
// the strong tier; `medium` = 0.4 is a gentle nudge; `easy` = 0 leaves the
// cheapest capable model winning. Calibratable, not magic.
export const BAND_SCORE: Record<NonNullable<DifficultySignals["semanticBand"]>, number> = {
  easy: 0,
  medium: 0.4,
  hard: 0.85,
};

// Lexical difficulty from the PROMPT — a cheap, instant, non-LLM first read of
// how hard the words say the task is. Catches the obvious cases the size signals
// miss (a bare prompt, no @files); returns null for genuinely ambiguous prompts
// ("fix it"), where the size signals (and, later, the LLM judge) decide. HARD is
// checked first: if a prompt mixes cues ("rename across the codebase"), the
// harder reading wins — conservative, the same philosophy as the rest of routing.
const HARD_CUES = /\b(race[ -]?condition|deadlock|concurren\w*|distributed|consensus|atomic\w*|mutex|semaphore|migrat\w*|memory leak|leak|security|vulnerab\w*|exploit|performance regression|re-?write|re-?architect\w*|thread[- ]?saf\w*|threading|backwards?[- ]compat\w*)\b/i;
// Multi-area work ("refactor X across all services") reads as hard even without a
// named hazard above.
const HARD_SPREAD = /\b(across (the |all |every )|throughout the)\b/i;
const EASY_CUES = /\b(typo|rename|bump|reword|re-?phrase|spelling|whitespace|formatting|lint|a comment|the comment|comments?\b)\b/i;

export function lexicalDifficulty(prompt: string): "easy" | "hard" | null {
  const p = prompt.toLowerCase();
  if (HARD_CUES.test(p) || HARD_SPREAD.test(p)) return "hard";
  if (EASY_CUES.test(p)) return "easy";
  return null;
}

export function estimateDifficulty(s: DifficultySignals): Difficulty {
  const reasons: string[] = [];
  let d = 0;

  if (s.estTokens != null) {
    const c = ramp(s.estTokens, CTX_FLOOR, CTX_CEIL) * W_CONTEXT;
    if (c > 0) { d += c; reasons.push(`large context (~${Math.round(s.estTokens / 1000)}k tok)`); }
  }
  if (s.touchedFileCount != null && s.touchedFileCount > 1) {
    const c = ramp(s.touchedFileCount, 1, FILES_CEIL) * W_FILES;
    if (c > 0) { d += c; reasons.push(`touches ${s.touchedFileCount} files`); }
  }
  if (s.touchedBytes != null) {
    const c = ramp(s.touchedBytes, BYTES_FLOOR, BYTES_CEIL) * W_BYTES;
    if (c > 0) { d += c; reasons.push(`large files (~${Math.round(s.touchedBytes / 1000)}KB)`); }
  }
  if (s.repoFailRate != null && s.repoFailRate > 0) {
    const c = clamp01(s.repoFailRate) * W_REPO;
    d += c; reasons.push(`repo code-fail ${Math.round(s.repoFailRate * 100)}%`);
  }
  if (s.centrality != null && s.centrality > 0) {
    const c = clamp01(s.centrality) * W_CENTRAL;
    d += c; reasons.push(`central code (high fan-in)`);
  }
  if (s.hasTestNet === false) {
    d += W_NO_NET; reasons.push(`no test net`);
  }

  // The semantic band combines by MAX: a hard-reading prompt raises difficulty
  // even with zero size signals (the whole point — a bare "fix the race
  // condition" has a small context but a hard task), while an easy reading never
  // drags a genuinely large task back down.
  const bandScore = s.semanticBand ? BAND_SCORE[s.semanticBand] : 0;
  if (bandScore > clamp01(d)) {
    reasons.push(`prompt reads ${s.semanticBand}`);
    return { d: bandScore, reasons };
  }

  return { d: clamp01(d), reasons };
}
