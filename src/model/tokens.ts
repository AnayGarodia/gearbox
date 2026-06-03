// Token counting for context budgeting — data-grounded, not chars/4.
//
// The chars/4 rule under-counts real model tokens by 12–48% (measured:
// experiments/models/tokenize.ts) — and an under-count is the dangerous
// direction: it overflows the context window. So we count with a real
// tokenizer (js-tiktoken o200k as a fast local base) and multiply by a
// per-model calibration factor measured against each provider's true
// tokenizer (Anthropic /v1/messages/count_tokens, ollama prompt_eval_count).
// Calibration lives in src/model/profiles.ts (provenance-tagged). For the
// exact Claude count there's an async path that hits count_tokens (free).
import { getEncoding, type Tiktoken } from "js-tiktoken";
import { profileFor, PROVIDER_CALIBRATION } from "./profiles.ts";
import type { ProviderId } from "../providers.ts";

let _enc: Tiktoken | null = null;
function enc(): Tiktoken {
  return (_enc ??= getEncoding("o200k_base"));
}

/** Raw tiktoken o200k count — the provider-agnostic base before calibration. */
export function baseTokens(text: string): number {
  return enc().encode(text).length;
}

// When the model is unknown, over-estimate (safe: never overflow). Claude runs
// the hottest above tiktoken of the families we carry, so its factor is the
// conservative default.
const DEFAULT_CALIBRATION = 1.35;

/**
 * Calibrated token estimate for `text` as `modelId` would tokenize it.
 * tiktoken base × the model's measured calibration. Falls back to the
 * provider calibration, then to a safe over-estimate when neither is known.
 */
export function countTokens(text: string, modelId?: string): number {
  const cal = modelId ? profileFor(modelId)?.tokenizer.calibration : undefined;
  return Math.ceil(baseTokens(text) * (cal ?? DEFAULT_CALIBRATION));
}

/** Calibrated estimate when you only know the provider, not the exact model. */
export function countTokensForProvider(text: string, provider: ProviderId): number {
  return Math.ceil(baseTokens(text) * (PROVIDER_CALIBRATION[provider] ?? DEFAULT_CALIBRATION));
}

/**
 * Exact token count from Anthropic's free /v1/messages/count_tokens. Use when
 * precision matters (e.g. validating a near-limit working set); the sync
 * countTokens is fine for routine budgeting. Returns null without a key or on
 * error so callers can fall back to the estimate.
 */
export async function countTokensExact(
  text: string,
  model = "claude-haiku-4-5",
  apiKey = process.env.ANTHROPIC_API_KEY,
): Promise<number | null> {
  if (!apiKey) return null;
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages/count_tokens", {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: text }] }),
    });
    const j: any = await r.json();
    return typeof j?.input_tokens === "number" ? j.input_tokens : null;
  } catch {
    return null;
  }
}
