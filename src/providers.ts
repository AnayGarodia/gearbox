// Provider layer: maps a friendly model id to an AI SDK model instance.
// Multi-provider from day one so routing (later) just scores over MODELS.
// This is the ONLY file that touches a concrete provider SDK.
import { anthropic, createAnthropic } from "@ai-sdk/anthropic";
import { openai, createOpenAI } from "@ai-sdk/openai";
import { google, createGoogleGenerativeAI } from "@ai-sdk/google";
import { deepseek, createDeepSeek } from "@ai-sdk/deepseek";
import type { LanguageModel } from "ai";
import { accountsForProvider } from "./accounts/store.ts";
import type { ResolvedCreds } from "./accounts/types.ts";

export type ProviderId = "anthropic" | "openai" | "google" | "deepseek";

export interface ModelSpec {
  id: string; // friendly id used everywhere, e.g. "claude-sonnet-4-6"
  provider: ProviderId;
  sdkId: string; // the provider's own model string
  label: string; // short display name, e.g. "sonnet-4.6"
  contextWindow: number; // approx tokens; used for the context indicator
  // Routing hints (seeded; the full corpus lives in src/model/profiles.ts).
  // Optional + additive so nothing breaks; the router will read these later.
  cost?: { inUSDPerMtok: number; outUSDPerMtok: number };
  speed?: { ttftMs: number; tps: number };
  quality?: number; // 0–1, e.g. SWE-bench Verified
}

// The registry. Adding a model is data, not code. Routing will score over this list.
// contextWindow values are approximate (for the UI's context %); refine as needed.
// cost values are approximate public list prices ($/Mtok) — used for the live
// session cost estimate in the status bar (and later by the router).
export const MODELS: ModelSpec[] = [
  { id: "claude-sonnet-4-6", provider: "anthropic", sdkId: "claude-sonnet-4-6", label: "sonnet-4.6", contextWindow: 200_000, cost: { inUSDPerMtok: 3, outUSDPerMtok: 15 } },
  { id: "claude-haiku-4-5", provider: "anthropic", sdkId: "claude-haiku-4-5", label: "haiku-4.5", contextWindow: 200_000, cost: { inUSDPerMtok: 0.8, outUSDPerMtok: 4 } },
  { id: "gpt-5.4", provider: "openai", sdkId: "gpt-5.4", label: "gpt-5.4", contextWindow: 256_000, cost: { inUSDPerMtok: 2.5, outUSDPerMtok: 10 } },
  { id: "gemini-2.5-pro", provider: "google", sdkId: "gemini-2.5-pro", label: "gemini-2.5-pro", contextWindow: 1_000_000, cost: { inUSDPerMtok: 1.25, outUSDPerMtok: 10 } },
  { id: "gemini-2.5-flash", provider: "google", sdkId: "gemini-2.5-flash", label: "gemini-flash", contextWindow: 1_000_000, cost: { inUSDPerMtok: 0.3, outUSDPerMtok: 2.5 } },
  { id: "deepseek-chat", provider: "deepseek", sdkId: "deepseek-chat", label: "deepseek", contextWindow: 128_000, cost: { inUSDPerMtok: 0.27, outUSDPerMtok: 1.1 } },
];

const ENV_KEY: Record<ProviderId, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
};

// Available if a stored account exists for it OR a key is in the env (back-compat
// + the zero-config demo path). Accounts are the durable path; env is the fallback.
export function providerAvailable(p: ProviderId): boolean {
  return accountsForProvider(p).length > 0 || Boolean(process.env[ENV_KEY[p]]);
}

export function findModel(idOrLabel: string): ModelSpec | undefined {
  return MODELS.find((m) => m.id === idOrLabel || m.label === idOrLabel);
}

/** Approximate USD cost of a set of turns, from each turn's model + token usage. */
export function estimateCost(turns: { model: string; inputTokens: number; outputTokens: number }[]): number {
  let usd = 0;
  for (const t of turns) {
    const c = MODELS.find((m) => m.id === t.model)?.cost;
    if (!c) continue;
    usd += (t.inputTokens / 1e6) * c.inUSDPerMtok + (t.outputTokens / 1e6) * c.outUSDPerMtok;
  }
  return usd;
}

// Build the AI SDK model instance. With `creds` (from an account) we configure
// the provider explicitly; without them we use the env-default instances
// (back-compat + demo). Any `creds.baseURL` routes through the OpenAI wire
// protocol — that one path covers every openai-compat provider, gateway, and
// local server, so adding those is data (a catalog row), not code here.
export function resolveModel(spec: ModelSpec, creds?: ResolvedCreds): LanguageModel {
  if (creds?.baseURL) {
    return createOpenAI({ baseURL: creds.baseURL, apiKey: creds.apiKey, headers: creds.headers })(spec.sdkId);
  }
  switch (spec.provider) {
    case "anthropic":
      return creds?.apiKey ? createAnthropic({ apiKey: creds.apiKey })(spec.sdkId) : anthropic(spec.sdkId);
    case "openai":
      return creds?.apiKey ? createOpenAI({ apiKey: creds.apiKey })(spec.sdkId) : openai(spec.sdkId);
    case "google":
      return creds?.apiKey ? createGoogleGenerativeAI({ apiKey: creds.apiKey })(spec.sdkId) : google(spec.sdkId);
    case "deepseek":
      return creds?.apiKey ? createDeepSeek({ apiKey: creds.apiKey })(spec.sdkId) : deepseek(spec.sdkId);
  }
}
