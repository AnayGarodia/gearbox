// ── ROUTING: LIVE IMPLEMENTATION OF THE MODEL SELECTOR SEAM ──────────────────
// RoutingSelector is the production ModelSelector. For each turn it picks the
// cheapest (model, account) pair that clears the task's quality bar. The
// guiding principle (DESIGN.md): "cheapest model that clears the quality bar".
// Never sacrifice quality on the main work; only delegate clearly bounded cheap
// sub-tasks (summarize, classify, search) to a cheaper model.
//
// Account awareness: every (model, account) pair is a candidate, including
// flat-rate subscription seats (Claude Max, ChatGPT). A seat you already pay
// for is effectively free until its 5-hour or weekly limit, so it wins by
// default and falls over to the metered API as the limit fills. Metered credit
// that is genuinely scarce (only where a provider exposes a live balance) is
// preserved. The scoring math lives in the pure scorer (src/model/scoring.ts);
// account state comes from a per-turn snapshot (src/model/routing-context.ts).
// Still call-free and deterministic per turn.
//
// Confidence-gated escalation: task.escalate (incremented when a cheap pick's
// verification fails) raises the quality bar so the router climbs to a stronger
// model instead of re-running the too-weak one. This is the reactive half of
// "cheapest model that clears the bar". A proactive shadow-eval version that
// escalates before the first miss is the intended follow-up.
import { modelRegistry, providerAvailable, subscriptionSeats, type ModelSpec } from "../providers.ts";
import { profileFor, outputFactorFor, cacheReadDiscount } from "./profiles.ts";
import { pickDefaultModel } from "../config.ts";
import { accountsForProvider } from "../accounts/store.ts";
import type { ModelSelector, Task, ModelChoice, Backend, Scorecard, ScorecardEntry } from "./selector.ts";
import { preferenceFor, globalPreference, policy, type Policy } from "./preferences.ts";
import { missingRequirements, supportsRequirements } from "./capabilities.ts";
import { buildRoutingContext, type AccountState, type RoutingContext } from "./routing-context.ts";
import { pickBest, scoreCandidate, type ScoreCandidate, type ScoredCandidate } from "./scoring.ts";
import { coolingDown, modelScopedKey, cooldownReason, classifyFailure } from "./cooldown.ts";
import { priorFor, priorLine, failRateFor, effortPassRate } from "./priors.ts";
import { estimateDifficulty, type Difficulty, type DifficultySignals } from "./difficulty.ts";
import { qualityForKind, qualityNote, benchmarkRow } from "./benchmarks.ts";
import { effortLevels } from "./reasoning.ts";
import { bestEffort } from "./effort.ts";
import { detectProofTier } from "../verify.ts";
import { statSync } from "node:fs";

// Per-turn context the effort search needs (difficulty + verifier set how much
// effort is worth; interactive sets the value of the extra latency).
interface EffortCtx { estInputTokens: number; difficulty: number; verifierTier: "tests" | "types" | "none"; interactive: boolean }

type Kind = NonNullable<Task["kind"]>;

// Fallback working-set size when the caller does not supply estTokens. The
// token count is shared across all candidates and most score terms scale
// linearly with it (cost, scarcity, switch, plan, latency are all proportional
// to costEst), so the relative ordering of those terms is unaffected by the
// exact value. The fixed limit/throttle penalties are NOT proportional, so this
// nominal size also calibrates how strongly an unsized turn avoids a near-limit
// account: it should stay in the ballpark of a real agent turn's input.
const NOMINAL_INPUT_TOKENS = 16_000;

// One (model, account) routing candidate, before scoring. `canonicalId` is the
// registry model id used for profile lookup (cost and quality); it differs from
// `spec.id` only for subscription seats, which mirror a canonical model's spec.
interface Candidate {
  spec: ModelSpec;
  canonicalId?: string;
  backend: Backend;
  state: AccountState;
}

// Capability FLOOR per task kind (0..1): the only quality threshold left — it
// excludes models that are genuinely INCAPABLE of the kind, so a cheap-but-junk
// model can never "win on price" for real work. It is NOT the old quality bar
// (which dictated WHICH tier to use); the expected-cost objective (scoring.ts)
// decides that from cost+latency+quality. code/plan floor out sub-0.4 models;
// cheap bounded kinds (summarize/classify/search/chat) have no floor — quality
// barely matters and cheapest should win.
const CAPABILITY_FLOOR: Record<Kind, number> = {
  summarize: 0,
  classify: 0,
  search: 0,
  chat: 0,
  plan: 0.4,
  code: 0.4,
};

// A verification MISS is hard evidence the chosen model failed THIS task here —
// not mere difficulty. Under a test net the objective treats a miss as cheap
// (caught + retried), so without a hard mechanism the router would re-pick the
// same failed cheap model forever. So each miss RAISES THE CAPABILITY FLOOR,
// excluding the failed tier and forcing a climb to a genuinely stronger model.
// BY HOW MUCH depends on WHAT failed (routing-bench finding): a test failure is
// a reasoning miss → climb hard; a mechanical failure (typecheck/lint/build —
// the compiler pinpointed the exact error) is an easy fix → barely move. This is
// evidence-driven, not an arbitrary bar.
const ESCALATION_FLOOR_BY_KIND: Record<NonNullable<Task["failureKind"]>, number> = {
  test: 0.35,
  other: 0.2,
  build: 0.12,
  typecheck: 0.07,
  lint: 0.05,
};
const escalationFloorStep = (fk: Task["failureKind"]): number => (fk ? ESCALATION_FLOOR_BY_KIND[fk] : 0.2);
const FLOOR_MAX = 0.9; // an escalated floor never excludes literally every model

// The flywheel's HARD stop: a model with a MEASURED per-repo fail rate at/above
// this (gated at ≥ MIN_N verified outcomes inside failRateFor) is EXCLUDED from
// routing here — "it keeps failing in THIS repo" is decisive evidence no
// benchmark or price can override. A soft cost nudge would be dominated by a big
// price gap under a test net, so the exclusion must be hard.
const MEASURED_FAIL_EXCLUDE = 0.5;

// Unambiguous mutation or repair verbs: their presence means real work is
// requested and the prompt should route to a strong model regardless of other
// signals. Kept intentionally tight: "test" and "build" are NOT included because
// they would swallow legitimate bounded sub-tasks such as "summarize the test
// output".
const MUTATION = /\b(fix|implement|refactor|edit|modif|debug|rewrite|replace|add|create|delete|remove|patch|migrat|rename)\b/;

// Greeting/ack words. A short prompt made ENTIRELY of these ("hi", "ok cool",
// "thanks!", "got it") is chat — no model call. Matched as a word SET (not a
// giant anchored regex) so multi-token acks like "ok cool" are caught while a
// real instruction that merely contains one ack word ("nice, refactor it") is
// not (it has a non-ack word, and MUTATION catches it anyway).
const ACK_WORDS = new Set([
  "hi", "hiya", "hello", "hey", "yo", "sup", "howdy", "thanks", "thank", "you", "ty", "thx",
  "ok", "okay", "k", "cool", "nice", "great", "perfect", "awesome", "sweet", "gotcha", "lol",
  "yep", "yeah", "yup", "sure", "good", "morning", "afternoon", "evening", "got", "it", "sounds",
]);

// Concrete code-defect signals → real DEBUGGING, which needs cross-file tracing,
// so it routes to a strong model EVEN when phrased as a question ("why is X
// throwing?", "where is the memory leak?"). This is the keyword judge's biggest
// hole: these used to fall through to the bar-0.3 "chat" fallback. Deliberately
// keyed on concrete failure words and error-CLASS names (TypeError, KeyError),
// never the bare word "error" — that also appears in cheap requests like "tl;dr
// this error log" / "classify this error".
const DEBUG = /\b(throw(s|n|ing)?|crash(es|ed|ing)?|fail(s|ed|ing|ure)?|broken|segfault|stack ?trace|traceback|exception|(type|key|value|index|name|runtime|reference|syntax|attribute|zero ?division|null ?pointer)error|times? out|timed out|memory leak|race condition|deadlock|infinite loop|stack ?overflow|regression|hang(s|ing)?|wrong (value|output|result|answer|behaviou?r)|went wrong|what'?s wrong|not working|is ?n'?t working|does ?n'?t work|wo ?n'?t (work|run|compile|build|start))\b/i;

// Design / architecture signals → PLANNING, a heavy reasoning task, even when
// phrased as a question ("how should we structure X?", "what's the tradeoff?").
// The other big hole: the keyword judge had no notion of planning at all, so
// these also fell to bar-0.3 chat. Both DEBUG→code and PLAN→plan land on the
// strong tier, so a false positive here is the SAFE (merely wasteful) direction.
const PLAN = /\b(architect(ure|ing)?|trade-?offs?)\b|\bbest (way|approach)\b|\bgood approach\b|\b(should|shall) (i|we|you)\b|\bhow (should|would|do) (i|we|you) (design|structure|architect|organi[sz]e|approach|split|break|model|scale)\b|\bplan (out|for)\b|\bdesign (a|an|the|our|your)\b|\bapproach (to|for)\b|\bhigh.level\b/i;

// Returns a task kind ONLY when a rule fires with confidence; null for genuinely
// ambiguous prompts so the LLM ladder (subscription seat, else cheapest API with
// consent) can judge them. The agent uses a non-null result to SKIP that hop.
// Order matters: a real change (MUTATION) or a defect/design signal (DEBUG/PLAN)
// outranks the cheap-kind markers, because misreading hard work as cheap is the
// only error that hurts. Cheap markers (summarize/classify/search) come last.
export function confidentKeywordKind(prompt: string): Kind | null {
  const p = prompt.toLowerCase().trim();
  if (!p) return null;
  // A short all-social prompt is chat by definition — never needs a model hop.
  const words = p.replace(/[^a-z'\s]/g, " ").split(/\s+/).filter(Boolean);
  if (words.length > 0 && words.length <= 3 && words.every((w) => ACK_WORDS.has(w))) return "chat";
  if (MUTATION.test(p)) return "code"; // a real change is requested, use a strong model
  // Debugging and design route to a strong model regardless of question shape.
  if (DEBUG.test(p)) return "code";
  if (PLAN.test(p)) return "plan";
  // "summarize" is a confident pure-summarize signal only when the prompt isn't
  // ALSO asking for tool work over the workspace: "read the files and summarize"
  // needs a model that drives tools across many files, but the summarize bar is
  // 0 and routes to the cheapest model, which then misunderstands the task
  // (user-reported). Mixed prompts fall through to the LLM classifier.
  if (/\b(summari[sz]e|tl;?dr|recap|condense|digest|gist)\b/.test(p)) {
    const workspaceWork = /\b(files?|codebase|repo(sitor(y|ies))?|director(y|ies)|folders?|read|scan|look (at|through)|go through|examine|analy[sz]e)\b/.test(p);
    return workspaceWork ? null : "summarize";
  }
  if (/\bclassif|\bcategori[sz]|\blabel this\b|\bsentiment\b|\byes or no\b|\btrue or false\b/.test(p)) return "classify";
  if (/^(find|search|locate|grep)\b|\bwhere is\b|\bwhich file\b/.test(p)) return "search";
  return null;
}

// An explanation/concept request ("explain X", "define Y", "how does Z work") is
// light → chat. Checked in the fallback below so that when an LLM IS available
// these still escalate to it (confidentKeywordKind returns null for them); this
// only fires on the keyword-only path (subscription-only / offline).
const CONCEPT = /^(explain|describe|define|eli5|tell me about|what'?s the difference|how does)\b/i;

// Question-shaped prompt with no confident match: "what is X", "is Y faster".
// Bare "do" is NOT a question opener unless followed by a pronoun, so the
// imperative "do the needful" routes to code while "does X…" / "do you…" stay
// questions. Used only by the fallback below — a confident keyword match always
// wins first.
const QUESTIONISH = /\?\s*$|^(how|what|why|who|whom|whose|when|where|which|is|are|was|were|does|did|can|could|should|would|will|may|might|has|have|had)\b|^do\s+(i|we|you|they)\b/i;

// Conservative keyword classifier used as the fallback when the LLM classifier
// is unavailable. A genuine concept/question prompt falls back to "chat" (a bare
// question never needs the code bar — "What is capital of India" must not route
// at 0.70); everything else ambiguous defaults to "code" (high bar) so real work
// is never silently downgraded.
export function classify(prompt: string): Kind {
  const confident = confidentKeywordKind(prompt);
  if (confident) return confident;
  const p = prompt.trim();
  if (CONCEPT.test(p)) return "chat"; // explanation/concept request → light tier
  return QUESTIONISH.test(p) ? "chat" : "code";
}

// Resolve quality on a 0..1 scale for a (candidate, kind). Trust order:
//   1. the REAL benchmark corpus, read PER KIND (benchmarks.ts) — researched
//      leaderboard data, the primary signal;
//   2. the legacy profile scalar (mostly seeded) — sweBenchVerified, then the
//      intelligence index normalised;
//   3. 0.5 neutral when nothing is known.
// Quality, 0..1, from the SINGLE source of truth: the researched benchmark
// corpus (benchmarks.ts), read per kind. The legacy profiles.ts quality scalars
// are deliberately NOT consulted here (review #6): they are mostly seeded and on
// a different scale (intelligenceIndex/100 vs the corpus's AA_INDEX_REF), so
// mixing them in one argmin compared models on incompatible numbers. A model
// absent from the corpus is UNKNOWN (0.5) and, for code/plan, floored out by the
// known-quality requirement in clearsFloor. profiles.ts keeps cost/latency/
// tokenizer; only quality moved to the corpus.
function qualityOf(c: Candidate, kind?: Kind): number {
  const q = kind ? qualityForKind(c.canonicalId ?? c.spec.id, kind) : null;
  return q ?? 0.5;
}

// True when the benchmark corpus has a real quality for this model. The capability
// floor uses it: a CLI seat with no benchmark gets the benefit of the doubt
// (kept); a metered model with no benchmark is floored out of code/plan.
function hasKnownQuality(c: Candidate): boolean {
  return !!benchmarkRow(c.canonicalId ?? c.spec.id);
}

function costPair(c: Candidate): { inUSDPerMtok: number; outUSDPerMtok: number } {
  const cost = profileFor(c.canonicalId ?? c.spec.id)?.cost ?? c.spec.cost;
  // Unknown cost sorts last. The sentinel 1e6 matches prior POSITIVE_INFINITY behaviour.
  return cost ?? { inUSDPerMtok: 1e6, outUSDPerMtok: 1e6 };
}

function tpsOf(c: Candidate): number {
  return profileFor(c.canonicalId ?? c.spec.id)?.latency?.tps ?? 0;
}

// Adapt a (Candidate) into the minimal numeric shape ScoreCandidate expects.
// Profile metrics resolve against the canonical model id (a subscription seat
// mirrors its canonical model's pricing and quality), falling back to the seat's
// own spec for cost when no profile exists.
// Every identity a policy rule might name for this candidate: account id/slug,
// provider id (both the spec's and — for seats — the account's "claude-cli").
function policyKeys(c: Candidate): string[] {
  return [c.state.accountId, c.backend.account?.slug, c.backend.account?.id, c.backend.account?.provider, c.spec.provider, c.state.provider]
    .filter(Boolean)
    .map((k) => String(k).toLowerCase());
}

// Standing-preference bias (a fraction of this turn's cost — scoring.ts
// preferBias): accountOrder rank gives a decaying nudge (first 0.1, second
// 0.05, …) so "use claude-work before claude-personal" resolves equivalent
// candidates in order; useFirst adds a strong drain bias while the named
// provider/account still has declared or live balance, so "burn the google
// credits first" actually burns them — and stops the moment they're gone.
function preferBiasFor(c: Candidate, pol: Policy | undefined): number {
  if (!pol) return 0;
  let b = 0;
  const keys = policyKeys(c);
  if (pol.accountOrder?.length) {
    const idx = pol.accountOrder.findIndex((k) => keys.includes(k.toLowerCase()));
    if (idx >= 0) b += 0.1 / (1 + idx);
  }
  if (pol.useFirst?.length && pol.useFirst.some((k) => keys.includes(k.toLowerCase()))) {
    // "Burn the google credits first" must actually WIN — including against a
    // flat-rate seat (planBonus ≈ 1.0×cost), or the policy silently does
    // nothing. 1.5×cost clears the seat bonus with margin while a genuinely
    // huge cost gap can still override. The off-switch is the balance: a
    // tracked balance (live, or estimated from /budget — declaring one is what
    // makes "credits" drainable) at ≤ 0 ends the bias, staleness included (a
    // stale zero still means the credits ran out; a refresh can only revive it).
    const drained = !c.state.isSubscription && c.state.balanceRemainingUSD !== undefined && c.state.balanceRemainingUSD <= 0;
    if (!drained) b += 1.5;
  }
  return b;
}

// Hard avoid-list filter ("no chinese models"): an explicit DON'T is respected
// even when it would empty the pool — the caller surfaces a clear error naming
// the rule instead of silently routing to an avoided model.
function applyAvoid(pool: Candidate[], pol: Policy | undefined): Candidate[] {
  if (!pol?.avoidProviders?.length && !pol?.avoidModels?.length) return pool;
  const avoidP = new Set((pol.avoidProviders ?? []).map((x) => x.toLowerCase()));
  const avoidM = new Set((pol.avoidModels ?? []).map((x) => x.toLowerCase()));
  return pool.filter((c) => {
    if (policyKeys(c).some((k) => avoidP.has(k))) return false;
    const ids = [c.spec.id, c.canonicalId, c.spec.sdkId].filter(Boolean).map((x) => String(x).toLowerCase());
    return !ids.some((id) => avoidM.has(id));
  });
}

// Unique scoring identity for a candidate. Two accounts can serve the SAME
// registry model (identical spec.id), so the winner lookup and the /why rows
// must key on the (account, model) PAIR — keying on spec.id alone collapsed
// same-model candidates and could return the wrong account from select().
// (Seats are already unique — their spec.id embeds the account — but routing
// every candidate through one identity keeps the invariant unconditional.)
function scoreId(c: Candidate): string {
  return `${c.state.accountId}::${c.spec.id}`;
}

function toScoreCandidate(c: Candidate, kind?: string, pol?: Policy, effortCtx?: EffortCtx): ScoreCandidate {
  const cost = costPair(c);
  const canonical = c.canonicalId ?? c.spec.id;
  // RAW per-kind benchmark quality (not prior-adjusted): the flywheel enters the
  // objective ONCE, via failRate → P(wrong) below, so folding the prior delta in
  // here too would double-count it. (The capability FLOOR uses the prior-adjusted
  // quality separately, to exclude a sunk model.)
  let quality = qualityOf(c, kind as Kind | undefined);
  let outputFactor = outputFactorFor(canonical);
  let ttftMs = profileFor(canonical)?.latency?.ttftMs ?? 0;
  let effort: string | undefined;
  // Auto-effort: pick the effort level minimizing expected cost for this model+
  // task (low for easy/netted work, high for hard/unnetted). The chosen effort's
  // adjusted quality/outputFactor/ttft then feed the model's own score, so the
  // model competes AT its best effort.
  if (effortCtx) {
    const levels = effortLevels(c.spec);
    if (levels.length) {
      const pick = bestEffort(
        { quality, inUSDPerMtok: cost.inUSDPerMtok, outUSDPerMtok: cost.outUSDPerMtok, tps: tpsOf(c), ttftMs, baseOutputFactor: outputFactor },
        levels,
        effortCtx,
        kind ? (level) => effortPassRate(kind, canonical, level)?.rate ?? null : undefined,
      );
      quality = pick.quality; outputFactor = pick.outputFactor; ttftMs = pick.ttftMs; effort = pick.level;
    }
  }
  return {
    id: scoreId(c),
    modelId: c.spec.id,
    inUSDPerMtok: cost.inUSDPerMtok,
    outUSDPerMtok: cost.outUSDPerMtok,
    quality,
    tps: tpsOf(c),
    ttftMs,
    account: c.state,
    // measured per-(kind,model) fail rate → the objective's P(wrong) (flywheel);
    // cache-read pricing → warm discount (CLI seats cache inside the vendor
    // binary → none); per-model + per-effort output verbosity → cost + latency.
    failRate: kind ? failRateFor(kind, canonical)?.rate : undefined,
    cacheReadDiscount: c.backend.kind === "cli" ? undefined : cacheReadDiscount(c.spec.provider) ?? undefined,
    outputFactor,
    preferBias: preferBiasFor(c, pol),
    effort,
  };
}

export class RoutingSelector implements ModelSelector {
  constructor(private fallbackId?: string) {}

  // The (account, model) this selector last returned — the cache-warm pair.
  // Used as the default `warm` for the scorer when the task does not supply
  // one, so near-tied candidates stick with the loaded model instead of
  // ping-ponging every turn. A task-supplied warm (the caller knows better,
  // e.g. after a failover hop landed elsewhere) always wins over this memory.
  private lastPick?: { accountId: string; modelId: string };

  private warmFor(task: Task): { accountId: string; modelId: string } | undefined {
    return task.warm ?? this.lastPick;
  }

  // Enumerate every (model, account) pair the user can run right now.
  // Registry models are paired with each enabled non-CLI account for their
  // provider, or with a neutral env-default state when no account is stored.
  // Subscription seats are appended as separate candidates. The result is the
  // complete pool; subsequent steps filter it by capability, context, and bar.
  private enumerate(ctx: RoutingContext): Candidate[] {
    const out: Candidate[] = [];
    const neutral = (id: string, provider: string): AccountState =>
      ctx.byAccountId.get(id) ?? { accountId: id, provider, exec: "in-loop", isSubscription: false };

    // routable:false (models.dev overlay) = pin-able via /model, never a
    // routing candidate — auto-routing only gambles on vetted models.
    for (const m of modelRegistry().filter((mm) => providerAvailable(mm.provider) && mm.routable !== false)) {
      const accts = accountsForProvider(m.provider).filter((a) => a.enabled && a.exec !== "cli");
      if (accts.length === 0) {
        // No stored account for this provider: use the env-key default state.
        out.push({ spec: m, canonicalId: m.id, backend: { kind: "in-loop" }, state: neutral(`env:${m.provider}`, m.provider) });
      } else {
        for (const a of accts) out.push({ spec: m, canonicalId: m.id, backend: { kind: "in-loop", account: a }, state: neutral(a.id, m.provider) });
      }
    }
    for (const seat of subscriptionSeats()) {
      const state = ctx.byAccountId.get(seat.account.id) ?? { accountId: seat.account.id, provider: seat.account.provider, exec: "cli" as const, isSubscription: true };
      out.push({ spec: seat.spec, canonicalId: seat.canonicalId, backend: { kind: "cli", account: seat.account, binary: seat.binary, profile: seat.profile }, state });
    }
    // Remove cooling candidates so the router routes around them. Two key shapes
    // (R-5): an account-wide park (billing/credit — the whole wallet is dry) and
    // a (account, model) park (rate/quota — siblings on the account still work).
    // If cooling would leave zero candidates, include them anyway: a cooling
    // account beats no model at all.
    const live = out.filter(
      (c) => !coolingDown(c.state.accountId, ctx.now) && !coolingDown(modelScopedKey(c.state.accountId, c.spec.id), ctx.now),
    );
    // Remember what cooldown removed: select() names a skipped subscription
    // seat in its reason, so a silent seat→API switch (user-reported) becomes
    // a visible, explained one.
    this.cooledOut = live.length ? out.filter((c) => !live.includes(c)) : [];
    return live.length ? live : out;
  }

  // Candidates excluded by cooldown in the most recent enumerate() pass.
  private cooledOut: Candidate[] = [];

  // Shared setup for select() and explain(). Builds the account snapshot,
  // enumerates all candidates, filters by capability and context window, applies
  // the global preference, and determines the bar-clearing set.
  // Throws when no model supports the required capabilities.
  // Returns a `fallback` field when the enumeration is empty (no keys configured).
  private prepare(task: Task): {
    kind: Kind; floor: number; escalate: number; required: string[]; ctx: RoutingContext;
    pool: Candidate[]; floored: Candidate[]; eligible: Candidate[]; estInputTokens: number;
    effDifficulty: number; verifierTier: "tests" | "types" | "none";
    pol?: Policy;
    difficulty?: Difficulty;
    fallback?: ModelSpec;
  } {
    const kind = task.kind ?? classify(task.prompt);
    const escalate = Math.max(0, Math.floor(task.escalate ?? 0));
    // Capability floor, RAISED by each prior miss (hard exclusion of the failed
    // tier — see ESCALATION_FLOOR_BY_KIND). A cheap kind has no base floor, but a
    // miss can still raise it. Capped so it never empties the pool.
    const floor = Math.min(FLOOR_MAX, CAPABILITY_FLOOR[kind] + escalate * escalationFloorStep(task.failureKind));
    // Verifier tier (caller-supplied, else this repo's, memoized): sets how
    // costly a miss is in the objective — a present net makes cheap-first safe;
    // none makes caution emerge. detectedVerifierTier returns "tests"/"types"/
    // "none" normally; it is undefined ONLY when detection THREW. On that
    // exception we fall back to "none" (caution) — assuming a full net ("tests")
    // there would invert the safety property exactly when we can't see the repo
    // (review #5): a likely-wrong cheap pick would look safe with no net to catch it.
    const verifierTier = task.verifierTier ?? detectedVerifierTier() ?? "none";
    // Difficulty WITHIN the kind (DESIGN: kind says WHAT, not HOW HARD). Pure,
    // non-LLM context signals (big working set, many/large touched files, a repo
    // where code keeps failing). Feeds the objective's P(wrong) — it raises a
    // hard task toward a stronger model where it matters most (no verifier net),
    // WITHOUT any arbitrary bar.
    let difficulty: Difficulty | undefined;
    let effDifficulty = 0;
    if (kind === "code" || kind === "plan") {
      difficulty = estimateDifficulty(gatherDifficultySignals(task, kind));
      effDifficulty = difficulty.d;
    }
    const required = task.requires ?? [];
    const ctx = buildRoutingContext(ctx_now());
    const estInputTokens = task.estTokens || NOMINAL_INPUT_TOKENS;

    const all = this.enumerate(ctx);
    if (all.length === 0) {
      // No API keys or seats configured: fall back to the default model if available.
      const m = pickDefaultModel(this.fallbackId);
      return { kind, floor, escalate, required, ctx, pool: [], floored: [], eligible: [], estInputTokens, effDifficulty, verifierTier, difficulty, fallback: m ?? undefined };
    }
    // Callers without seat dispatch machinery opt out of cli-backend candidates.
    const dispatchable = task.inLoopOnly ? all.filter((c) => c.backend.kind === "in-loop") : all;
    // Filter to models that satisfy every required capability.
    const capable = required.length ? dispatchable.filter((c) => supportsRequirements(c.spec, required)) : dispatchable;
    if (capable.length === 0) {
      const missing = all.slice(0, 4).map((c) => `${c.spec.label}: ${missingRequirements(c.spec, required).join(", ")}`).join("; ");
      throw new Error(`No configured model supports this turn (${required.join(", ")} required). ${missing}`);
    }
    // Remove models whose context window is too small for the estimated working set.
    // A 20% headroom is added so tool outputs don't overflow mid-turn.
    const need = (task.estTokens ?? 0) * 1.2;
    const fits = need > 0 ? capable.filter((c) => c.spec.contextWindow >= need) : capable;
    // If nothing fits the context requirement, use the full capable set (prefer
    // a likely-too-small model over no model at all).
    // `eligible` is the capability/context-filtered set BEFORE the global
    // preference narrows it: an explicit per-kind /prefer is searched against
    // THIS set, so "/prefer code haiku" wins even when a global preference
    // (e.g. "subscription only") would have filtered haiku out of the pool.
    // The AVOID lists apply even earlier and even to /prefer: an explicit
    // "don't use X" beats every other instruction, and if it excludes every
    // model the turn fails LOUDLY (naming the rule) rather than betraying it.
    const pol = policy();
    const allowed = applyAvoid(fits.length ? fits : capable, pol);
    if (!allowed.length) {
      const rules = [...(pol?.avoidProviders ?? []), ...(pol?.avoidModels ?? [])].join(", ");
      throw new Error(`Your policy avoids every available model (avoiding: ${rules}) — this blocks every routed turn, including delegates and compaction. /prefer allow <name> lifts a rule (/prefer shows the policy), or add an account.`);
    }
    const eligible = allowed;
    const pool = applyGlobalPreference(eligible);
    // Capability FLOOR (the only quality threshold left): exclude models that are
    // genuinely incapable of this kind, so a cheap-but-junk model can never win
    // on price. NOT the old bar — it does not pick the tier, only removes the
    // unqualified. A CLI seat with no benchmark gets the benefit of the doubt
    // (kept). Prior-adjusted so a model the flywheel has sunk here floors out too.
    const adjQuality = (c: Candidate): number => qualityOf(c, kind) + (priorFor(kind, c.canonicalId ?? c.spec.id)?.delta ?? 0);
    const clearsFloor = (c: Candidate): boolean => {
      // Flywheel hard stop: a model proven to keep failing HERE is excluded.
      if ((failRateFor(kind, c.canonicalId ?? c.spec.id)?.rate ?? 0) >= MEASURED_FAIL_EXCLUDE) return false;
      if (floor === 0) return true; // cheap kinds have no floor — quality is irrelevant
      // A CLI seat with no benchmark gets the benefit of the doubt (a known-good
      // vendor model). A METERED model with NO known quality (e.g. a discovered
      // gateway/Foundry model absent from both corpora) must NOT clear a code/plan
      // floor on the 0.5 default guess (review #3) — require real, known quality.
      if (c.backend?.kind === "cli") return !hasKnownQuality(c) || adjQuality(c) >= floor;
      return hasKnownQuality(c) && adjQuality(c) >= floor;
    };
    // If the floor would empty the pool (everything is sub-floor), keep the
    // strongest available rather than failing — a weak model beats no model.
    let floored = floor > 0 ? pool.filter(clearsFloor) : pool;
    if (!floored.length) {
      const top = Math.max(...pool.map(adjQuality));
      floored = pool.filter((c) => (c.backend?.kind === "cli" && !hasKnownQuality(c)) || adjQuality(c) >= top - 1e-9);
    }
    return { kind, floor, escalate, required, ctx, pool, floored, eligible, estInputTokens, pol, difficulty, effDifficulty, verifierTier };
  }

  // Return the per-kind remembered preference if it is present in the given
  // candidate set. A preference can be a specific model id or just a provider.
  private preferredIn(kind: Kind, candidates: Candidate[]): Candidate | undefined {
    const pref = preferenceFor(kind);
    return pref?.modelId
      ? candidates.find((c) => c.canonicalId === pref.modelId || c.spec.id === pref.modelId)
      : pref?.provider
        ? candidates.find((c) => c.spec.provider === pref.provider)
        : undefined;
  }

  select(task: Task): ModelChoice {
    const p = this.prepare(task);
    if (p.pool.length === 0) {
      if (!p.fallback) {
        throw new Error("No model available. Set a key: ANTHROPIC_API_KEY / OPENAI_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY / DEEPSEEK_API_KEY");
      }
      return { model: p.fallback, reason: "only model with a key", backend: { kind: "in-loop" } };
    }
    // Candidates that clear the capability floor (else the whole pool).
    const candidates = p.floored.length ? p.floored : p.pool;
    // An explicit /prefer is searched in the ELIGIBLE set (capability- and
    // context-filtered, but BEFORE the global preference and the floor), so
    // "prefer haiku for code" wins even when a global preference filtered it out.
    const preferred = this.preferredIn(p.kind, p.eligible);
    if (preferred) {
      this.lastPick = { accountId: preferred.state.accountId, modelId: preferred.spec.id };
      return { model: preferred.spec, reason: `${p.kind} · remembered preference`, backend: preferred.backend };
    }

    // Score by expected cost-to-correct (cost + latency + quality), argmin. Each
    // candidate is scored AT its best effort (auto-effort routing).
    const flags = { now: p.ctx.now, estInputTokens: p.estInputTokens, interactive: task.interactive, warm: this.warmFor(task), difficulty: p.effDifficulty, verifierTier: p.verifierTier };
    const effortCtx: EffortCtx = { estInputTokens: p.estInputTokens, difficulty: p.effDifficulty, verifierTier: p.verifierTier, interactive: !!task.interactive };
    const best = pickBest({ candidates: candidates.map((c) => toScoreCandidate(c, p.kind, p.pol, effortCtx)), ...flags });
    const winner = candidates.find((c) => scoreId(c) === best.candidate.id)!;
    this.lastPick = { accountId: winner.state.accountId, modelId: winner.spec.id };
    const escalated = p.escalate > 0 ? ` · escalated after ${p.escalate} failed check${p.escalate === 1 ? "" : "s"}` : "";
    const hardNote = p.difficulty && p.difficulty.d > 0 ? ` · hard: ${p.difficulty.reasons.join(", ")}` : "";
    // Transparency: when a subscription seat serving this same model sat out
    // the race on a cooldown, say so — the user sees a seat turn silently
    // become a metered-API turn otherwise and reads it as a routing bug.
    const skippedSeat =
      winner.backend?.kind !== "cli"
        ? this.cooledOut.find((c) => c.backend?.kind === "cli" && (c.canonicalId ?? c.spec.id) === (winner.canonicalId ?? winner.spec.id))
        : undefined;
    const effort = best.candidate.effort;
    const effortNote = effort ? ` · effort ${effort}` : "";
    return { model: winner.spec, reason: reasonFor(winner, p.kind, p.required) + escalated + hardNote + effortNote + seatSkipNote(skippedSeat, p.ctx.now), backend: winner.backend, effort };
  }

  // Build the full ranked scorecard for the "/why" UI panel. Scores the entire
  // pool (including below-bar candidates) so the UI can show why each model was
  // excluded. Mirrors select()'s winner exactly so the scorecard always agrees
  // with the actual routing decision. Pure read; no side effects.
  explain(task: Task): Scorecard {
    const p = this.prepare(task);
    const entries: ScorecardEntry[] = [];
    if (p.pool.length === 0) {
      return { kind: p.kind, bar: p.floor, prompt: task.prompt, entries, note: p.fallback ? `only ${p.fallback.label} has a key` : "no model available" };
    }
    const candidates = p.floored.length ? p.floored : p.pool;
    const preferred = this.preferredIn(p.kind, p.eligible);

    // Score the WHOLE pool (incl. floored-out) so the UI shows every candidate,
    // with the SAME expected-cost flags select() uses, so numbers + winner match.
    const flags = { now: p.ctx.now, estInputTokens: p.estInputTokens, interactive: task.interactive, warm: this.warmFor(task), difficulty: p.effDifficulty, verifierTier: p.verifierTier };
    const effortCtx: EffortCtx = { estInputTokens: p.estInputTokens, difficulty: p.effDifficulty, verifierTier: p.verifierTier, interactive: !!task.interactive };
    const scored = new Map<string, ScoredCandidate>();
    for (const s of p.pool.map((c) => scoreCandidate(toScoreCandidate(c, p.kind, p.pol, effortCtx), { candidates: [], ...flags }))) scored.set(s.candidate.id, s);
    const winnerId = preferred
      ? scoreId(preferred)
      : pickBest({ candidates: candidates.map((c) => toScoreCandidate(c, p.kind, p.pol, effortCtx)), ...flags }).candidate.id;

    // Mirror prepare()'s capability floor so the verdict matches what select did.
    const adjQuality = (c: Candidate): number => qualityOf(c, p.kind) + (priorFor(p.kind, c.canonicalId ?? c.spec.id)?.delta ?? 0);
    const clearsFloor = (c: Candidate): boolean => {
      if ((failRateFor(p.kind, c.canonicalId ?? c.spec.id)?.rate ?? 0) >= MEASURED_FAIL_EXCLUDE) return false;
      if (p.floor === 0) return true;
      if (c.backend?.kind === "cli") return !hasKnownQuality(c) || adjQuality(c) >= p.floor;
      return hasKnownQuality(c) && adjQuality(c) >= p.floor;
    };
    for (const c of p.pool) {
      const s = scored.get(scoreId(c))!;
      const capable = p.floor === 0 || clearsFloor(c);
      const chosen = scoreId(c) === winnerId;
      const pl = priorLine(p.kind, c.canonicalId ?? c.spec.id);
      entries.push({
        label: c.spec.label,
        backend: c.backend.kind === "cli" ? "seat" : "api",
        quality: adjQuality(c),
        priorNote: pl ?? qualityNote(c.canonicalId ?? c.spec.id, p.kind) ?? undefined,
        qualitySrc: benchmarkRow(c.canonicalId ?? c.spec.id) ? "researched" : (profileFor(c.canonicalId ?? c.spec.id)?.quality.src ?? "seeded"),
        estCostPerMtok: costPerMtok(c),
        balanceText: balanceText(c.state),
        headroomText: headroomText(c.state),
        // slug ?? label inline (not commands.ts accountName) to avoid an import cycle
        accountLabel: c.backend.account ? (c.backend.account.slug ?? c.backend.account.label) : undefined,
        headroomPct: c.state.isSubscription && c.state.rateHeadroom !== undefined ? Math.round(c.state.rateHeadroom * 100) : undefined,
        score: s.score,
        chosen,
        verdict: chosen ? (preferred ? "preferred" : "chosen") : !capable ? "below capability floor" : verdictFor(c, s),
      });
    }
    // Sort: chosen first, then capable candidates by score (ascending), then the
    // floored-out ones last.
    entries.sort((a, b) => Number(b.chosen) - Number(a.chosen) || Number(b.verdict !== "below capability floor") - Number(a.verdict !== "below capability floor") || a.score - b.score);
    const cooledNote = this.cooledOut.length
      ? `cooling down, not scored: ${[...new Set(this.cooledOut.map((c) => `${c.spec.label} via ${c.state.accountId}`))].join(", ")}`
      : undefined;
    const diffNote = p.difficulty && p.difficulty.d > 0
      ? `harder than baseline (${p.difficulty.reasons.join(", ")})`
      : undefined;
    return { kind: p.kind, bar: p.floor, prompt: task.prompt, entries, note: [diffNote, cooledNote].filter(Boolean).join(" · ") || undefined };
  }
}

function costPerMtok(c: Candidate): number {
  const { inUSDPerMtok, outUSDPerMtok } = costPair(c);
  // Blended cost: input dominates agent turns (80% in, 20% out).
  return inUSDPerMtok + 0.2 * outUSDPerMtok;
}

function balanceText(s: AccountState): string | undefined {
  if (s.isSubscription || s.balanceRemainingUSD === undefined) return undefined;
  const v = s.balanceRemainingUSD;
  const amt = v >= 100 ? `$${Math.round(v)}` : `$${v.toFixed(2)}`;
  return s.balanceEstimated ? `${amt} est` : amt;
}

function headroomText(s: AccountState): string | undefined {
  if (s.isSubscription && s.rateHeadroom !== undefined) return `${Math.round(s.rateHeadroom * 100)}% left`;
  if (!s.isSubscription && s.apiThrottle !== undefined && s.apiThrottle < 0.15) return "throttling";
  return undefined;
}

function verdictFor(c: Candidate, s: ScoredCandidate): string {
  if (c.state.isSubscription) return "seat ~free";
  if (s.terms.scarcity > s.terms.costEst) return "scarce credit";
  if (s.terms.apiThrottlePenalty > 0) return "near limit";
  return "ok";
}

// Apply the global preference as a hard filter, relaxed if it would empty the pool.
// Each preference criterion (subscription vs api, account id, provider) narrows
// the pool only when the result is non-empty.
function applyGlobalPreference(pool: Candidate[]): Candidate[] {
  const g = globalPreference();
  if (!g) return pool;
  let p = pool;
  const keep = (next: Candidate[]) => { if (next.length) p = next; };
  if (g.prefer === "subscription") keep(p.filter((c) => c.state.isSubscription));
  else if (g.prefer === "api") keep(p.filter((c) => !c.state.isSubscription));
  if (g.accountId) keep(p.filter((c) => c.state.accountId === g.accountId));
  if (g.provider) keep(p.filter((c) => c.spec.provider === g.provider || c.state.provider === g.provider));
  return p;
}

// Build the human-readable reason string shown in the UI and routing scorecard.
// Shows in/out prices separately rather than a blended rate, because a blended
// rate is neither the input price nor the output price and is therefore misleading.
/** Why a cooled-out seat sat out, in the parked reason's own words: a rate
 *  park heals itself, an auth park needs the user (`/account login <name>`).
 *  Hardcoding "(rate limited)" here misdiagnosed expired logins (review). */
function seatSkipNote(seat: Candidate | undefined, now: number): string {
  if (!seat) return "";
  const acct = seat.state.accountId;
  const reason = cooldownReason(acct, now) ?? cooldownReason(modelScopedKey(acct, seat.spec.id), now) ?? "";
  const why = classifyFailure(reason) === "auth" ? `signed out — /account login ${acct} to use it again` : "rate limited — back automatically when the window clears";
  return ` · ${acct} seat skipped (${why})`;
}

function reasonFor(c: Candidate, kind: Kind, required: string[]): string {
  const caps = required.length ? ` · ${required.join("+")} required` : "";
  if (c.backend.kind === "cli") return `${kind}${caps} · ${c.backend.binary} subscription · seat`;
  const { inUSDPerMtok, outUSDPerMtok } = costPair(c);
  return `${kind}${caps} · $${inUSDPerMtok.toFixed(2)}/$${outUSDPerMtok.toFixed(2)} per Mtok in/out`;
}

// Wall-clock time, isolated into its own function so the rest of the routing
// code reads as a pure function of the snapshot. Keep this tiny: only this
// function calls Date.now(); everything else receives `now` as an argument.
function ctx_now(): number {
  return Date.now();
}

// ── Difficulty signal gathering (cheap, non-LLM) ─────────────────────────────
// Whether the current repo has a runnable verify check (test/build/typecheck) —
// the "net" that makes starting on a cheaper model safe (a miss is caught, not
// shipped). Memoized per cwd: detection reads package.json / globs once, then the
// router reuses it on every turn so it never adds I/O to the hot path.
// This repo's verifier tier (tests/types/none) — the "net" that decides whether
// cheap-first is safe (a miss is caught) or risky (a miss ships). Memoized per
// cwd: detection reads package.json / globs once, then the router reuses it so it
// never adds I/O to the hot path. Used as the fallback when the caller does not
// supply task.verifierTier.
let verifierTierMemo: { cwd: string; tier: "tests" | "types" | "none" | undefined } | undefined;
function detectedVerifierTier(): "tests" | "types" | "none" | undefined {
  try {
    const cwd = process.cwd();
    if (verifierTierMemo?.cwd !== cwd) verifierTierMemo = { cwd, tier: detectProofTier(cwd, []) };
    return verifierTierMemo.tier;
  } catch {
    return undefined; // detection failed → neutral, never block routing
  }
}

// Collect the cheap, non-LLM difficulty signals for a code/plan turn from the
// Task plus local repo state. statSync on touched files is fast; capped at 20
// and guarded so a missing/huge file list never throws or stalls routing.
// (The test-net signal lives in prepare()'s verifier-tier caution, not here, so
// the no-net penalty has exactly one owner.)
function gatherDifficultySignals(task: Task, _kind: Kind): DifficultySignals {
  // The files in play, supplied by the caller (App threads the @mentioned files +
  // the session's recently-changed files — see App.tsx). The router stays PURE
  // and deterministic: no repo I/O on the routing hot path, so a pick never
  // depends on the working tree's index state.
  const files = task.touchedFiles ?? [];
  let touchedBytes: number | undefined;
  if (files.length) {
    let sum = 0, counted = 0;
    for (const f of files.slice(0, 20)) {
      try { sum += statSync(f).size; counted++; } catch { /* missing file → skip */ }
    }
    if (counted) touchedBytes = sum;
  }
  // NOTE: repoFailRate is deliberately NOT a difficulty signal — the per-(kind,
  // model) measured fail rate already enters the objective via failRate→P(wrong),
  // and folding the repo-aggregate in here too double-counted the same evidence
  // (review #4). Difficulty = how hard the TASK is; failRate = how the MODEL does.
  return {
    estTokens: task.estTokens,
    touchedFileCount: files.length || undefined,
    touchedBytes,
  };
}

// Installed when the user explicitly chooses an account with `/account use`.
// Bypasses routing entirely and always runs the specified subscription seat.
// This is the hard-pin half of "pins beat auto"; RoutingSelector handles the
// auto-routing half. Mirrors FixedSelector for model pins.
export class SubscriptionPinSelector implements ModelSelector {
  constructor(private accountId: string, private modelId?: string) {}

  select(_task: Task): ModelChoice {
    const seats = subscriptionSeats().filter((s) => s.account.id === this.accountId);
    if (seats.length === 0) throw new Error(`Subscription account ${this.accountId} is not available. Use /account to re-add it, or /account off for routing.`);
    const seat = (this.modelId && seats.find((s) => s.spec.sdkId === this.modelId || s.canonicalId === this.modelId)) || seats[0]!;
    return {
      model: seat.spec,
      reason: `pinned ${seat.binary} subscription`,
      backend: { kind: "cli", account: seat.account, binary: seat.binary, profile: seat.profile },
    };
  }
}
