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
// deterministic. (Deferred to a follow-up with shadow-eval: confidence-gating a
// hard task away from a seeded-quality cheap model.)
import { modelRegistry, providerAvailable, subscriptionSeats, type ModelSpec } from "../providers.ts";
import { profileFor } from "./profiles.ts";
import { pickDefaultModel } from "../config.ts";
import { accountsForProvider } from "../accounts/store.ts";
import type { ModelSelector, Task, ModelChoice, Backend } from "./selector.ts";
import { preferenceFor, globalPreference } from "./preferences.ts";
import { missingRequirements, supportsRequirements } from "./capabilities.ts";
import { buildRoutingContext, type AccountState, type RoutingContext } from "./routing-context.ts";
import { pickBest, type ScoreCandidate } from "./scoring.ts";

type Kind = NonNullable<Task["kind"]>;

// A representative working-set size for the cost estimate when the caller doesn't
// pass one. Cost ordering only depends on the per-Mtok rates (the token count is
// shared across candidates), so this just has to be positive.
const NOMINAL_INPUT_TOKENS = 16_000;

// One (model, account) routing candidate, before scoring. `canonicalId` is the
// registry model id used for profile lookup (cost/quality) — it differs from
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

// Any unambiguous mutation/repair verb means real work → never downgrade, even
// if the prompt also says "find" or "summarize" (e.g. "find and fix the bug",
// "summarize and refactor"). Kept tight on purpose: NOT "test"/"build", which
// would swallow legit bounded sub-tasks like "summarize the test output".
const MUTATION = /\b(fix|implement|refactor|edit|modif|debug|rewrite|replace|add|create|delete|remove|patch|migrat|rename)\b/;

// Conservative classifier: default to "code" (high bar) unless the prompt is
// clearly a cheap bounded sub-task. We never silently downgrade real work; we
// only grab a cheaper model when we're fairly sure it's safe.
export function classify(prompt: string): Kind {
  const p = prompt.toLowerCase().trim();
  if (!p) return "code";
  if (MUTATION.test(p)) return "code"; // a real change is requested — strong model
  if (/\b(summari[sz]e|tl;?dr|recap|condense|digest|gist)\b/.test(p)) return "summarize";
  if (/\bclassif|\bcategori[sz]|\blabel this\b|\bsentiment\b/.test(p)) return "classify";
  if (/^(find|search|locate|grep)\b|\bwhere is\b|\bwhich file\b/.test(p)) return "search";
  return "code";
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

function costPair(c: Candidate): { inUSDPerMtok: number; outUSDPerMtok: number } {
  const cost = profileFor(c.canonicalId ?? c.spec.id)?.cost ?? c.spec.cost;
  // Unknown cost sorts last (matches the old POSITIVE_INFINITY behavior).
  return cost ?? { inUSDPerMtok: 1e6, outUSDPerMtok: 1e6 };
}

function tpsOf(c: Candidate): number {
  return profileFor(c.canonicalId ?? c.spec.id)?.latency?.tps ?? 0;
}

// Map a routing candidate to the pure scorer's minimal numeric view.
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
    return out;
  }

  select(task: Task): ModelChoice {
    const kind = task.kind ?? classify(task.prompt);
    const bar = BAR[kind];
    const required = task.requires ?? [];
    const ctx = buildRoutingContext(ctx_now());

    const all = this.enumerate(ctx);
    if (all.length === 0) {
      const m = pickDefaultModel(this.fallbackId);
      if (!m) {
        throw new Error(
          "No model available. Set a key: ANTHROPIC_API_KEY / OPENAI_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY / DEEPSEEK_API_KEY",
        );
      }
      return { model: m, reason: "only model with a key", backend: { kind: "in-loop" } };
    }

    // Capability gate (vision, tools, …) — never route a turn to a model that
    // can't run it, even if cheaper.
    const capable = required.length ? all.filter((c) => supportsRequirements(c.spec, required)) : all;
    if (capable.length === 0) {
      const missing = all
        .slice(0, 4)
        .map((c) => `${c.spec.label}: ${missingRequirements(c.spec, required).join(", ")}`)
        .join("; ");
      throw new Error(`No configured model supports this turn (${required.join(", ")} required). ${missing}`);
    }

    // Context-window guard, then global hard-preference filter (subscription/api,
    // account, provider) — each relaxes if it would empty the pool.
    const need = (task.estTokens ?? 0) * 1.2;
    const fits = need > 0 ? capable.filter((c) => c.spec.contextWindow >= need) : capable;
    let pool = fits.length ? fits : capable;
    pool = applyGlobalPreference(pool);

    // Quality bar: the candidates that clear it (else the best we have).
    const clears = pool.filter((c) => qualityOf(c) >= bar);
    const candidates = clears.length ? clears : pool;

    // A confirmed per-kind preference wins when it still clears the bar (the
    // remembered-routing path), checked across the bar-clearing set.
    const pref = preferenceFor(kind);
    const preferred = pref?.modelId
      ? candidates.find((c) => c.canonicalId === pref.modelId || c.spec.id === pref.modelId)
      : pref?.provider
        ? candidates.find((c) => c.spec.provider === pref.provider)
        : undefined;
    if (preferred) return { model: preferred.spec, reason: `${kind} · remembered preference`, backend: preferred.backend };

    // Otherwise score every candidate (cost + scarcity + limits − plan bonus).
    const best = pickBest({
      candidates: candidates.map(toScoreCandidate),
      now: ctx.now,
      estInputTokens: task.estTokens || NOMINAL_INPUT_TOKENS,
    });
    const winner = candidates.find((c) => c.spec.id === best.candidate.id)!;
    return { model: winner.spec, reason: reasonFor(winner, kind, required), backend: winner.backend };
  }
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
  return `${kind}${caps} · $${(inUSDPerMtok + 0.2 * outUSDPerMtok).toFixed(2)}/Mtok`;
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
