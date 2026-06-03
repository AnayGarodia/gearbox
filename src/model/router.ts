// ── BASIC ROUTING ──────────────────────────────────────────────────────────
// The first real implementation of the ModelSelector seam: pick the model per
// task instead of a fixed default. The principle (DESIGN.md) is "cheapest model
// that clears the quality bar for this task" — never sacrifice quality on the
// main work, only delegate clearly-bounded cheap sub-tasks (summarize/classify/
// search) to a cheaper model. Data comes from the measured/researched corpus
// (src/model/profiles.ts); only models whose provider has a key are considered.
//
// This is intentionally heuristic and call-free (no classifier model) — "basic".
// The richer router (shadow-eval, credit/limit penalties, confidence) layers on
// top without changing this interface.
import { MODELS, providerAvailable, type ModelSpec } from "../providers.ts";
import { profileFor } from "./profiles.ts";
import { pickDefaultModel } from "../config.ts";
import type { ModelSelector, Task, ModelChoice } from "./selector.ts";

type Kind = NonNullable<Task["kind"]>;

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

function qualityOf(m: ModelSpec): number {
  const pr = profileFor(m.id);
  if (!pr) return 0.5;
  if (pr.quality.sweBenchVerified != null) return pr.quality.sweBenchVerified;
  if (pr.quality.intelligenceIndex != null) return pr.quality.intelligenceIndex / 100;
  return 0.5;
}

// Input-weighted blended price (agent turns are input-heavy: system + repo map +
// retrieved files + history dwarf the output).
function costOf(m: ModelSpec): number {
  const pr = profileFor(m.id);
  if (!pr) return Number.POSITIVE_INFINITY;
  return pr.cost.inUSDPerMtok + 0.2 * pr.cost.outUSDPerMtok;
}

function tpsOf(m: ModelSpec): number {
  return profileFor(m.id)?.latency?.tps ?? 0;
}

export class RoutingSelector implements ModelSelector {
  constructor(private fallbackId?: string) {}

  select(task: Task): ModelChoice {
    const kind = task.kind ?? classify(task.prompt);
    const bar = BAR[kind];

    const available = MODELS.filter((m) => providerAvailable(m.provider) && profileFor(m.id));
    if (available.length === 0) {
      const m = pickDefaultModel(this.fallbackId);
      if (!m) {
        throw new Error(
          "No model available. Set a key: ANTHROPIC_API_KEY / OPENAI_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY / DEEPSEEK_API_KEY",
        );
      }
      return { model: m, reason: "only model with a key" };
    }

    // Context-window guard: drop models that can't hold the estimated working set
    // (with headroom). If none fit, keep all (best effort — the builder still trims).
    const need = (task.estTokens ?? 0) * 1.2;
    const fits = need > 0 ? available.filter((m) => m.contextWindow >= need) : available;
    const pool = fits.length ? fits : available;

    // Cheapest model that clears the bar; if nothing clears it, the best one we have.
    const clears = pool.filter((m) => qualityOf(m) >= bar);
    const candidates = clears.length ? clears : pool;
    candidates.sort(
      (a, b) => costOf(a) - costOf(b) || tpsOf(b) - tpsOf(a) || qualityOf(b) - qualityOf(a),
    );
    const model = candidates[0]!;

    const why = clears.length ? "cheapest clearing the bar" : "best available";
    const reason = `${kind} · ${why} · $${costOf(model).toFixed(2)}/Mtok`;
    return { model, reason };
  }
}
