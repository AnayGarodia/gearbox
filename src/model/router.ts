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
import { profileFor } from "./profiles.ts";
import { pickDefaultModel } from "../config.ts";
import { accountsForProvider } from "../accounts/store.ts";
import type { ModelSelector, Task, ModelChoice, Backend, Scorecard, ScorecardEntry } from "./selector.ts";
import { preferenceFor, globalPreference } from "./preferences.ts";
import { missingRequirements, supportsRequirements } from "./capabilities.ts";
import { buildRoutingContext, type AccountState, type RoutingContext } from "./routing-context.ts";
import { pickBest, scoreCandidate, type ScoreCandidate, type ScoredCandidate } from "./scoring.ts";
import { coolingDown, modelScopedKey } from "./cooldown.ts";
import { priorFor, priorLine } from "./priors.ts";

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

// Quality bar per task kind (SWE-bench-Verified-ish, 0..1): minimum quality a
// model must have to qualify for this task. Bounded sub-tasks (summarize,
// classify, search) have no bar so the cheapest model wins. Real coding and
// planning demand a strong model (0.7 clears Sonnet+ but not Haiku).
const BAR: Record<Kind, number> = {
  summarize: 0,
  classify: 0,
  search: 0.2,
  chat: 0.3,
  plan: 0.7,
  code: 0.7,
};

// Each failed verification raises the quality bar by ESCALATION_STEP, climbing
// the model ladder toward stronger candidates. BAR_MAX ensures the bar never
// excludes every model: if no candidate clears the raised bar, prepare() promotes
// to the strongest available tier rather than dropping back to cheapest.
const ESCALATION_STEP = 0.08;
const BAR_MAX = 0.95;

// Unambiguous mutation or repair verbs: their presence means real work is
// requested and the prompt should route to a strong model regardless of other
// signals. Kept intentionally tight: "test" and "build" are NOT included because
// they would swallow legitimate bounded sub-tasks such as "summarize the test
// output".
const MUTATION = /\b(fix|implement|refactor|edit|modif|debug|rewrite|replace|add|create|delete|remove|patch|migrat|rename)\b/;

// Returns a task kind ONLY when a rule fires unambiguously: a mutation verb maps
// to "code", and explicit summarize/classify/search markers map to their kinds.
// Returns null for ambiguous prompts (a bare question, an explanation request)
// so the LLM classifier can handle them properly. The agent uses this to SKIP
// the model call (and its 1-2s latency) when the signal is already clear.
export function confidentKeywordKind(prompt: string): Kind | null {
  const p = prompt.toLowerCase().trim();
  if (!p) return null;
  if (MUTATION.test(p)) return "code"; // a real change is requested, use a strong model
  if (/\b(summari[sz]e|tl;?dr|recap|condense|digest|gist)\b/.test(p)) return "summarize";
  if (/\bclassif|\bcategori[sz]|\blabel this\b|\bsentiment\b/.test(p)) return "classify";
  if (/^(find|search|locate|grep)\b|\bwhere is\b|\bwhich file\b/.test(p)) return "search";
  return null;
}

// Question-shaped prompt with no mutation verb: "what is X", "how does Y work",
// or anything ending in "?". Used only by the fallback below — a confident
// keyword match (incl. MUTATION → code) always wins first.
const QUESTIONISH = /^(how|what|who|when|where|why|which|can|does|do|is|are)\b|\?\s*$/i;

// Conservative keyword classifier used as a fallback when the LLM classifier is
// unavailable. A question-shaped prompt with no mutation verb falls back to
// "chat" (a bare question never needs the code bar — "What is capital of India"
// must not route at 0.70); everything else ambiguous defaults to "code" (high
// bar) so real work is never silently downgraded.
export function classify(prompt: string): Kind {
  const confident = confidentKeywordKind(prompt);
  if (confident) return confident;
  return QUESTIONISH.test(prompt.trim()) ? "chat" : "code";
}

// Resolve quality from the canonical model profile. Uses sweBenchVerified if
// available (primary signal), falls back to intelligenceIndex normalised to 0..1,
// then to 0.5 as a neutral placeholder when neither is present.
function qualityOf(c: Candidate): number {
  const pr = profileFor(c.canonicalId ?? c.spec.id);
  if (!pr) return 0.5;
  if (pr.quality.sweBenchVerified != null) return pr.quality.sweBenchVerified;
  if (pr.quality.intelligenceIndex != null) return pr.quality.intelligenceIndex / 100;
  return 0.5;
}

// Returns true when the profile contains at least one real quality benchmark.
// Used by the bar-clearing predicate: a CLI seat with no benchmark is given the
// benefit of the doubt (assumed to clear) rather than penalised for a 0.5 guess.
function hasKnownQuality(c: Candidate): boolean {
  const pr = profileFor(c.canonicalId ?? c.spec.id);
  return !!pr && (pr.quality.sweBenchVerified != null || pr.quality.intelligenceIndex != null);
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
function toScoreCandidate(c: Candidate, kind?: string): ScoreCandidate {
  const cost = costPair(c);
  const prior = kind ? priorFor(kind, c.canonicalId ?? c.spec.id) : null;
  return { id: c.spec.id, inUSDPerMtok: cost.inUSDPerMtok, outUSDPerMtok: cost.outUSDPerMtok, quality: qualityOf(c) + (prior?.delta ?? 0), tps: tpsOf(c), account: c.state };
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
    return live.length ? live : out;
  }

  // Shared setup for select() and explain(). Builds the account snapshot,
  // enumerates all candidates, filters by capability and context window, applies
  // the global preference, and determines the bar-clearing set.
  // Throws when no model supports the required capabilities.
  // Returns a `fallback` field when the enumeration is empty (no keys configured).
  private prepare(task: Task): {
    kind: Kind; bar: number; escalate: number; required: string[]; ctx: RoutingContext;
    pool: Candidate[]; clears: Candidate[]; eligible: Candidate[]; estInputTokens: number;
    fallback?: ModelSpec;
  } {
    const kind = task.kind ?? classify(task.prompt);
    const escalate = Math.max(0, Math.floor(task.escalate ?? 0));
    // Each prior miss lifts the bar so the router climbs to a stronger model.
    const bar = escalate > 0 ? Math.min(BAR_MAX, BAR[kind] + escalate * ESCALATION_STEP) : BAR[kind];
    const required = task.requires ?? [];
    const ctx = buildRoutingContext(ctx_now());
    const estInputTokens = task.estTokens || NOMINAL_INPUT_TOKENS;

    const all = this.enumerate(ctx);
    if (all.length === 0) {
      // No API keys or seats configured: fall back to the default model if available.
      const m = pickDefaultModel(this.fallbackId);
      return { kind, bar, escalate, required, ctx, pool: [], clears: [], eligible: [], estInputTokens, fallback: m ?? undefined };
    }
    // Filter to models that satisfy every required capability.
    const capable = required.length ? all.filter((c) => supportsRequirements(c.spec, required)) : all;
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
    const eligible = fits.length ? fits : capable;
    const pool = applyGlobalPreference(eligible);
    // Seats with no quality profile clear the bar unconditionally (do not
    // penalise them on a 0.5 guess). Seats with a known-weak quality (e.g.
    // Haiku) are still held to the bar so they are not chosen for hard tasks
    // just because they are free and fast.
    // Measured per-repo priors (the flywheel): a model that keeps failing
    // verification HERE has its effective quality pulled down — enough turns
    // of red and it sinks below the bar for this repo's work. Conservative,
    // asymmetric, and silent until ≥8 verified outcomes exist (priors.ts).
    const adjQuality = (c: Candidate): number => qualityOf(c) + (priorFor(kind, c.canonicalId ?? c.spec.id)?.delta ?? 0);
    const clearsAdj = (c: Candidate): boolean =>
      c.backend?.kind === "cli" ? !hasKnownQuality(c) || adjQuality(c) >= bar : adjQuality(c) >= bar;
    let clears = pool.filter(clearsAdj);
    // If the raised bar (from escalation) leaves nothing, promote to the
    // strongest available tier. Without this, the fallback below would drop
    // to the cheapest candidate, which is the opposite of escalating.
    if (escalate > 0 && clears.length === 0) {
      const top = Math.max(...pool.map(qualityOf));
      clears = pool.filter((c) => c.backend?.kind === "cli" || qualityOf(c) >= top - 1e-9);
    }
    return { kind, bar, escalate, required, ctx, pool, clears, eligible, estInputTokens };
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
    // Use the bar-clearing set when one exists; otherwise fall back to the full pool.
    const candidates = p.clears.length ? p.clears : p.pool;
    // An explicit /prefer must be searched in the ELIGIBLE set (capability- and
    // context-filtered, but BEFORE the global preference and the bar). Otherwise
    // "prefer haiku for code" was silently ignored when haiku sits below the
    // code bar, or when a global preference filtered it out of the pool — a
    // per-kind preference is the more specific instruction, so it wins.
    const preferred = this.preferredIn(p.kind, p.eligible);
    if (preferred) {
      this.lastPick = { accountId: preferred.state.accountId, modelId: preferred.spec.id };
      return { model: preferred.spec, reason: `${p.kind} · remembered preference`, backend: preferred.backend };
    }

    // Score all bar-clearing candidates and pick the winner.
    const best = pickBest({ candidates: candidates.map((c) => toScoreCandidate(c, p.kind)), now: p.ctx.now, estInputTokens: p.estInputTokens, interactive: task.interactive, warm: this.warmFor(task) });
    const winner = candidates.find((c) => c.spec.id === best.candidate.id)!;
    this.lastPick = { accountId: winner.state.accountId, modelId: winner.spec.id };
    const escalated = p.escalate > 0 ? ` · escalated after ${p.escalate} failed check${p.escalate === 1 ? "" : "s"}` : "";
    return { model: winner.spec, reason: reasonFor(winner, p.kind, p.required) + escalated, backend: winner.backend };
  }

  // Build the full ranked scorecard for the "/why" UI panel. Scores the entire
  // pool (including below-bar candidates) so the UI can show why each model was
  // excluded. Mirrors select()'s winner exactly so the scorecard always agrees
  // with the actual routing decision. Pure read; no side effects.
  explain(task: Task): Scorecard {
    const p = this.prepare(task);
    const entries: ScorecardEntry[] = [];
    if (p.pool.length === 0) {
      return { kind: p.kind, bar: p.bar, prompt: task.prompt, entries, note: p.fallback ? `only ${p.fallback.label} has a key` : "no model available" };
    }
    const candidates = p.clears.length ? p.clears : p.pool;
    // Explicit preference overrides the bar and the global filter, matching select().
    const preferred = this.preferredIn(p.kind, p.eligible);

    // Score the entire pool (including below-bar) so the UI can display all
    // candidates. The winner is still determined from the bar-clearing set only.
    // The SAME flags (warm, interactive) as select() feed every score here, so
    // the scorecard's numbers — and its winner — match the actual pick.
    const flags = { now: p.ctx.now, estInputTokens: p.estInputTokens, interactive: task.interactive, warm: this.warmFor(task) };
    const scored = new Map<string, ScoredCandidate>();
    // scoreCandidate ignores input.candidates (it scores one candidate against
    // the flags only), so the empty array here is inert — it just satisfies the
    // ScoreInput shape without re-listing the pool per call.
    for (const s of p.pool.map((c) => scoreCandidate(toScoreCandidate(c, p.kind), { candidates: [], ...flags }))) scored.set(s.candidate.id, s);
    const winnerId = preferred
      ? preferred.spec.id
      : pickBest({ candidates: candidates.map((c) => toScoreCandidate(c, p.kind)), ...flags }).candidate.id;

    // Mirror prepare()'s prior-adjusted predicate so the scorecard verdict
    // matches what the router actually did (seat with unknown quality clears;
    // a model whose measured per-repo prior sinks it below the bar shows
    // "below bar" here too, exactly as select() excluded it).
    const adjQuality = (c: Candidate): number => qualityOf(c) + (priorFor(p.kind, c.canonicalId ?? c.spec.id)?.delta ?? 0);
    const clearsAdj = (c: Candidate): boolean =>
      c.backend?.kind === "cli" ? !hasKnownQuality(c) || adjQuality(c) >= p.bar : adjQuality(c) >= p.bar;
    for (const c of p.pool) {
      const s = scored.get(c.spec.id)!;
      const clears = clearsAdj(c);
      const chosen = c.spec.id === winnerId;
      const pl = priorLine(p.kind, c.canonicalId ?? c.spec.id);
      entries.push({
        label: c.spec.label,
        backend: c.backend.kind === "cli" ? "seat" : "api",
        quality: qualityOf(c) + (priorFor(p.kind, c.canonicalId ?? c.spec.id)?.delta ?? 0),
        priorNote: pl ?? undefined,
        qualitySrc: profileFor(c.canonicalId ?? c.spec.id)?.quality.src ?? "seeded",
        estCostPerMtok: costPerMtok(c),
        balanceText: balanceText(c.state),
        headroomText: headroomText(c.state),
        // slug ?? label inline (not commands.ts accountName) to avoid an import cycle
        accountLabel: c.backend.account ? (c.backend.account.slug ?? c.backend.account.label) : undefined,
        headroomPct: c.state.isSubscription && c.state.rateHeadroom !== undefined ? Math.round(c.state.rateHeadroom * 100) : undefined,
        score: s.score,
        chosen,
        verdict: chosen ? (preferred ? "preferred" : "chosen") : !clears ? "below bar" : verdictFor(c, s),
      });
    }
    // Sort: chosen first, then bar-clearing candidates by score (ascending, so
    // best candidates are listed first), then below-bar candidates.
    entries.sort((a, b) => Number(b.chosen) - Number(a.chosen) || Number(b.verdict !== "below bar") - Number(a.verdict !== "below bar") || a.score - b.score);
    return { kind: p.kind, bar: p.bar, prompt: task.prompt, entries };
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
