// ── ROUTING ──────────────────────────────────────────────────────────────────
// The ModelSelector seam's live implementation: pick the model AND the account
// per task. The principle (DESIGN.md) is "cheapest model that clears the task's
// quality bar" — never sacrifice quality on the main work, only delegate clearly
// bounded cheap sub-tasks (summarize/classify/search) to a cheaper model.
//
// Beyond cost it is now ACCOUNT-AWARE: every (model, account) pair is a candidate,
// including flat-rate subscription SEATS (Claude Max / ChatGPT). A seat you
// already pay for is ≈free until its 5-hour/weekly limit, so it wins by default
// and falls over to metered API as the limit fills — and metered credit that's
// genuinely scarce (only where a provider exposes a balance) is preserved. The
// math lives in the pure scorer (src/model/scoring.ts); account state comes from
// a per-turn snapshot (src/model/routing-context.ts). Still call-free and
// deterministic. Confidence-gating is now REACTIVE: `task.escalate` (set when a
// cheap pick's checks fail) raises the quality bar so the router climbs to a
// stronger model instead of re-running the too-weak one. (A proactive, shadow-eval
// version that escalates BEFORE the first miss is the eventual follow-up.)
import { modelRegistry, providerAvailable, subscriptionSeats, type ModelSpec } from "../providers.ts";
import { profileFor } from "./profiles.ts";
import { pickDefaultModel } from "../config.ts";
import { accountsForProvider } from "../accounts/store.ts";
import type { ModelSelector, Task, ModelChoice, Backend, Scorecard, ScorecardEntry } from "./selector.ts";
import { preferenceFor, globalPreference } from "./preferences.ts";
import { missingRequirements, supportsRequirements } from "./capabilities.ts";
import { buildRoutingContext, type AccountState, type RoutingContext } from "./routing-context.ts";
import { pickBest, scoreCandidate, type ScoreCandidate, type ScoredCandidate } from "./scoring.ts";
import { coolingDown } from "./cooldown.ts";

type Kind = NonNullable<Task["kind"]>;

// Fallback working-set size when the caller doesn't supply estTokens. Cost ordering
// depends only on per-Mtok rates (token count is shared across candidates), so the
// exact value doesn't matter as long as it's positive.
const NOMINAL_INPUT_TOKENS = 16_000;

// One (model, account) routing candidate, before scoring. `canonicalId` is the
// registry model id used for profile lookup (cost/quality); it differs from
// `spec.id` only for subscription seats, which mirror a canonical model.
interface Candidate {
  spec: ModelSpec;
  canonicalId?: string;
  backend: Backend;
  state: AccountState;
}

// Quality bar per task kind (sweBench-Verified-ish, 0..1): how good a model must
// be to qualify. Bounded sub-tasks have no bar (cheapest wins); real coding and
// planning demand a strong model.
const BAR: Record<Kind, number> = {
  summarize: 0,
  classify: 0,
  search: 0.2,
  chat: 0.3,
  plan: 0.7,
  code: 0.7,
};

// Each failed verification raises the quality bar by this much, climbing the model
// ladder. BAR_MAX ensures something always clears; if no candidate clears the raised
// bar, prepare() promotes to the strongest available tier rather than falling to cheapest.
const ESCALATION_STEP = 0.08;
const BAR_MAX = 0.95;

// Any unambiguous mutation/repair verb means real work → never downgrade, even
// if the prompt also says "find" or "summarize" (e.g. "find and fix the bug",
// "summarize and refactor"). Kept tight on purpose: NOT "test"/"build", which
// would swallow legit bounded sub-tasks like "summarize the test output".
const MUTATION = /\b(fix|implement|refactor|edit|modif|debug|rewrite|replace|add|create|delete|remove|patch|migrat|rename)\b/;

// Confident keyword classification: returns a kind ONLY when a rule clearly
// fires (a mutation verb, or an explicit summarize/classify/search marker), and
// null otherwise. The null case is the ambiguous one — a bare question or
// explanation that would wrongly default to "code" — which is exactly where the
// LLM classifier earns its keep. The agent uses this to SKIP the model call
// (and its ~1-2s latency) whenever the signal is already clear.
export function confidentKeywordKind(prompt: string): Kind | null {
  const p = prompt.toLowerCase().trim();
  if (!p) return null;
  if (MUTATION.test(p)) return "code"; // a real change is requested — strong model
  if (/\b(summari[sz]e|tl;?dr|recap|condense|digest|gist)\b/.test(p)) return "summarize";
  if (/\bclassif|\bcategori[sz]|\blabel this\b|\bsentiment\b/.test(p)) return "classify";
  if (/^(find|search|locate|grep)\b|\bwhere is\b|\bwhich file\b/.test(p)) return "search";
  return null;
}

// Conservative keyword classifier: default to "code" (high bar) unless the prompt
// is clearly a cheap bounded sub-task. Used as the fallback when the LLM
// classifier isn't available; never silently downgrades real work.
export function classify(prompt: string): Kind {
  return confidentKeywordKind(prompt) ?? "code";
}

// Profile metrics resolve against the CANONICAL model id (a subscription seat
// mirrors a real model), falling back to the seat's own spec for cost.
function qualityOf(c: Candidate): number {
  const pr = profileFor(c.canonicalId ?? c.spec.id);
  if (!pr) return 0.5;
  if (pr.quality.sweBenchVerified != null) return pr.quality.sweBenchVerified;
  if (pr.quality.intelligenceIndex != null) return pr.quality.intelligenceIndex / 100;
  return 0.5;
}

// Whether a model has a real quality prior. A seat with unknown quality clears the bar
// unconditionally (we don't penalize it for a 0.5 guess); a seat with known quality is held to the bar.
function hasKnownQuality(c: Candidate): boolean {
  const pr = profileFor(c.canonicalId ?? c.spec.id);
  return !!pr && (pr.quality.sweBenchVerified != null || pr.quality.intelligenceIndex != null);
}

// Bar-clearing predicate, curried on the bar. API candidates must have quality >= bar.
// Seats also clear when quality is unknown (don't drop them on a 0.5 guess).
const clearsBar = (bar: number) => (c: Candidate): boolean =>
  c.backend?.kind === "cli" ? !hasKnownQuality(c) || qualityOf(c) >= bar : qualityOf(c) >= bar;

function costPair(c: Candidate): { inUSDPerMtok: number; outUSDPerMtok: number } {
  const cost = profileFor(c.canonicalId ?? c.spec.id)?.cost ?? c.spec.cost;
  // Unknown cost sorts last; sentinel 1e6 matches prior POSITIVE_INFINITY behavior.
  return cost ?? { inUSDPerMtok: 1e6, outUSDPerMtok: 1e6 };
}

function tpsOf(c: Candidate): number {
  return profileFor(c.canonicalId ?? c.spec.id)?.latency?.tps ?? 0;
}

// Adapter: strip (model, account) down to the minimal numeric view the pure scorer expects.
function toScoreCandidate(c: Candidate): ScoreCandidate {
  const cost = costPair(c);
  return { id: c.spec.id, inUSDPerMtok: cost.inUSDPerMtok, outUSDPerMtok: cost.outUSDPerMtok, quality: qualityOf(c), tps: tpsOf(c), account: c.state };
}

export class RoutingSelector implements ModelSelector {
  constructor(private fallbackId?: string) {}

  // Every (model, account) pair the user can run right now: in-loop registry
  // models paired with each enabled account that serves their provider (or a
  // neutral env-default state when there's no stored account), PLUS subscription
  // seats. Default users (one env key, no accounts) get exactly today's pool.
  private enumerate(ctx: RoutingContext): Candidate[] {
    const out: Candidate[] = [];
    const neutral = (id: string, provider: string): AccountState =>
      ctx.byAccountId.get(id) ?? { accountId: id, provider, exec: "in-loop", isSubscription: false };

    for (const m of modelRegistry().filter((mm) => providerAvailable(mm.provider))) {
      const accts = accountsForProvider(m.provider).filter((a) => a.enabled && a.exec !== "cli");
      if (accts.length === 0) {
        out.push({ spec: m, canonicalId: m.id, backend: { kind: "in-loop" }, state: neutral(`env:${m.provider}`, m.provider) });
      } else {
        for (const a of accts) out.push({ spec: m, canonicalId: m.id, backend: { kind: "in-loop", account: a }, state: neutral(a.id, m.provider) });
      }
    }
    for (const seat of subscriptionSeats()) {
      const state = ctx.byAccountId.get(seat.account.id) ?? { accountId: seat.account.id, provider: seat.account.provider, exec: "cli" as const, isSubscription: true };
      out.push({ spec: seat.spec, canonicalId: seat.canonicalId, backend: { kind: "cli", account: seat.account, binary: seat.binary, profile: seat.profile }, state });
    }
    // Drop accounts on a failover cooldown (just hit a 429 / out of quota) so the
    // router routes AROUND them — relaxed if that would leave nothing (a cooling
    // account beats no model at all).
    const live = out.filter((c) => !coolingDown(c.state.accountId, ctx.now));
    return live.length ? live : out;
  }

  // Shared setup for select() and explain(): build the snapshot, enumerate candidates,
  // gate by capability/context/global-preference, and identify the bar-clearing set.
  // Throws when no capable model exists. Returns `fallback` when enumeration is empty.
  private prepare(task: Task): {
    kind: Kind; bar: number; escalate: number; required: string[]; ctx: RoutingContext;
    pool: Candidate[]; clears: Candidate[]; estInputTokens: number;
    fallback?: ModelSpec;
  } {
    const kind = task.kind ?? classify(task.prompt);
    const escalate = Math.max(0, Math.floor(task.escalate ?? 0));
    // Each prior miss lifts the bar by ESCALATION_STEP so the router climbs to a stronger model.
    const bar = escalate > 0 ? Math.min(BAR_MAX, BAR[kind] + escalate * ESCALATION_STEP) : BAR[kind];
    const required = task.requires ?? [];
    const ctx = buildRoutingContext(ctx_now());
    const estInputTokens = task.estTokens || NOMINAL_INPUT_TOKENS;

    const all = this.enumerate(ctx);
    if (all.length === 0) {
      const m = pickDefaultModel(this.fallbackId);
      return { kind, bar, escalate, required, ctx, pool: [], clears: [], estInputTokens, fallback: m ?? undefined };
    }
    const capable = required.length ? all.filter((c) => supportsRequirements(c.spec, required)) : all;
    if (capable.length === 0) {
      const missing = all.slice(0, 4).map((c) => `${c.spec.label}: ${missingRequirements(c.spec, required).join(", ")}`).join("; ");
      throw new Error(`No configured model supports this turn (${required.join(", ")} required). ${missing}`);
    }
    const need = (task.estTokens ?? 0) * 1.2;
    const fits = need > 0 ? capable.filter((c) => c.spec.contextWindow >= need) : capable;
    let pool = fits.length ? fits : capable;
    pool = applyGlobalPreference(pool);
    // Seats with no quality profile (e.g. non-native sdkIds) clear the bar unconditionally;
    // seats with a known-weak quality (e.g. haiku) are still held to the bar so they
    // aren't chosen for hard tasks just because they're free and fast (R-3).
    let clears = pool.filter(clearsBar(bar));
    // If the raised bar clears nobody, promote to the strongest available tier.
    // Without this, select's fallback would drop to the cheapest — the opposite of escalating.
    if (escalate > 0 && clears.length === 0) {
      const top = Math.max(...pool.map(qualityOf));
      clears = pool.filter((c) => c.backend?.kind === "cli" || qualityOf(c) >= top - 1e-9);
    }
    return { kind, bar, escalate, required, ctx, pool, clears, estInputTokens };
  }

  // The per-kind remembered preference, when it's present in the candidate set.
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
    const candidates = p.clears.length ? p.clears : p.pool;
    // An EXPLICIT /prefer overrides the quality-bar default, so look it up in the
    // whole pool — otherwise "prefer haiku for code" was silently ignored because
    // haiku sits below the code bar and never entered `clears`.
    const preferred = this.preferredIn(p.kind, p.pool);
    if (preferred) return { model: preferred.spec, reason: `${p.kind} · remembered preference`, backend: preferred.backend };

    const best = pickBest({ candidates: candidates.map(toScoreCandidate), now: p.ctx.now, estInputTokens: p.estInputTokens, interactive: task.interactive });
    const winner = candidates.find((c) => c.spec.id === best.candidate.id)!;
    const escalated = p.escalate > 0 ? ` · escalated after ${p.escalate} failed check${p.escalate === 1 ? "" : "s"}` : "";
    return { model: winner.spec, reason: reasonFor(winner, p.kind, p.required) + escalated, backend: winner.backend };
  }

  // The full ranked "why": every candidate scored, with the per-term breakdown,
  // quality provenance, and balance/headroom — the data the ⌃tab scorecard shows.
  // Pure read; no side effects. Mirrors select()'s winner exactly.
  explain(task: Task): Scorecard {
    const p = this.prepare(task);
    const entries: ScorecardEntry[] = [];
    if (p.pool.length === 0) {
      return { kind: p.kind, bar: p.bar, prompt: task.prompt, entries, note: p.fallback ? `only ${p.fallback.label} has a key` : "no model available" };
    }
    const candidates = p.clears.length ? p.clears : p.pool;
    const preferred = this.preferredIn(p.kind, p.pool); // explicit pref overrides the bar (match select())

    // Score the WHOLE pool (incl. below-bar) for display; the winner is chosen
    // only from the bar-clearing set, matching select().
    const scored = new Map<string, ScoredCandidate>();
    for (const s of p.pool.map((c) => scoreCandidate(toScoreCandidate(c), { candidates: [], now: p.ctx.now, estInputTokens: p.estInputTokens }))) scored.set(s.candidate.id, s);
    const winnerId = preferred
      ? preferred.spec.id
      : pickBest({ candidates: candidates.map(toScoreCandidate), now: p.ctx.now, estInputTokens: p.estInputTokens, interactive: task.interactive }).candidate.id;

    const clearsForBar = clearsBar(p.bar);
    for (const c of p.pool) {
      const s = scored.get(c.spec.id)!;
      const clears = clearsForBar(c); // same rule select() uses (seats: unknown-quality clears, known-weak doesn't)
      const chosen = c.spec.id === winnerId;
      entries.push({
        label: c.spec.label,
        backend: c.backend.kind === "cli" ? "seat" : "api",
        quality: qualityOf(c),
        qualitySrc: profileFor(c.canonicalId ?? c.spec.id)?.quality.src ?? "seeded",
        estCostPerMtok: costPerMtok(c),
        balanceText: balanceText(c.state),
        headroomText: headroomText(c.state),
        score: s.score,
        chosen,
        verdict: chosen ? (preferred ? "preferred" : "chosen") : !clears ? "below bar" : verdictFor(c, s),
      });
    }
    // Best first: chosen, then bar-clearing by score, then below-bar.
    entries.sort((a, b) => Number(b.chosen) - Number(a.chosen) || Number(b.verdict !== "below bar") - Number(a.verdict !== "below bar") || a.score - b.score);
    return { kind: p.kind, bar: p.bar, prompt: task.prompt, entries };
  }
}

function costPerMtok(c: Candidate): number {
  const { inUSDPerMtok, outUSDPerMtok } = costPair(c);
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

// Global preference as a hard filter, relaxed if it would leave nothing.
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

function reasonFor(c: Candidate, kind: Kind, required: string[]): string {
  const caps = required.length ? ` · ${required.join("+")} required` : "";
  if (c.backend.kind === "cli") return `${kind}${caps} · ${c.backend.binary} subscription · seat`;
  const { inUSDPerMtok, outUSDPerMtok } = costPair(c);
  // Show the real in/out prices, not a single blended number presented as a rate
  // (the old "$X/Mtok" was in + 0.2·out, which is neither price — misleading). R-7.
  return `${kind}${caps} · $${inUSDPerMtok.toFixed(2)}/$${outUSDPerMtok.toFixed(2)} per Mtok in/out`;
}

// Wall clock, isolated so the rest of select() reads as pure (everything else is
// a function of the snapshot). Kept tiny for the deterministic-on-snapshot story.
function ctx_now(): number {
  return Date.now();
}

// A subscription seat the router picked but the user wants to OVERRIDE-pin: this
// selector is installed when the user explicitly chooses an account (`/account
// use`), so routing is bypassed and that seat always runs — the hard-pin half of
// "pins beat auto". Mirrors FixedSelector for a model pin.
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
