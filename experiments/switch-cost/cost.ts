// Token + cost model. Uses one tokenizer (o200k_base) as a consistent proxy
// across providers — absolute counts differ per provider tokenizer, but the
// RATIO we care about (full transcript vs curated projection) is robust to that.

import { getEncoding } from "js-tiktoken";

const enc = getEncoding("o200k_base");

export function countTokens(text: string): number {
  return enc.encode(text).length;
}

// Serialize a rendered payload to the text that drives input-token cost.
// JSON.stringify captures system + messages + tool schemas + args + results.
export function payloadTokens(payload: any): number {
  const { model, ...rest } = payload; // drop the placeholder model field
  return countTokens(JSON.stringify(rest));
}

// 2026 input prices, USD per 1M tokens (from pricing research).
export const PRICE_PER_MTOK_INPUT: Record<string, number> = {
  "claude-opus-4-8": 5.0,
  "claude-sonnet-4-6": 3.0,
  "claude-haiku-4-5": 0.25,
  "gpt-5.4": 2.5,
  "gemini-2.5-pro": 1.25,
  "gemini-3.1-flash-lite": 0.1,
  "deepseek-v3": 0.27,
  "deepseek-v4-pro": 0.435,
};

export function inputCostUSD(tokens: number, model: string): number {
  const price = PRICE_PER_MTOK_INPUT[model];
  if (price == null) throw new Error(`no price for ${model}`);
  return (tokens / 1_000_000) * price;
}
