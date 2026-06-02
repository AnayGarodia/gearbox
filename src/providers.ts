// Provider layer: maps a friendly model id to an AI SDK model instance.
// Multi-provider from day one so routing (later) just scores over MODELS.
// This is the ONLY file that touches a concrete provider SDK.
import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import { google } from "@ai-sdk/google";
import { deepseek } from "@ai-sdk/deepseek";
import type { LanguageModel } from "ai";

export type ProviderId = "anthropic" | "openai" | "google" | "deepseek";

export interface ModelSpec {
  id: string; // friendly id used everywhere, e.g. "claude-sonnet-4-6"
  provider: ProviderId;
  sdkId: string; // the provider's own model string
  label: string; // short display name, e.g. "sonnet-4.6"
  contextWindow: number; // approx tokens; used for the context indicator
}

// The registry. Adding a model is data, not code. Routing will score over this list.
// contextWindow values are approximate (for the UI's context %); refine as needed.
export const MODELS: ModelSpec[] = [
  { id: "claude-sonnet-4-6", provider: "anthropic", sdkId: "claude-sonnet-4-6", label: "sonnet-4.6", contextWindow: 200_000 },
  { id: "claude-haiku-4-5", provider: "anthropic", sdkId: "claude-haiku-4-5", label: "haiku-4.5", contextWindow: 200_000 },
  { id: "gpt-5.4", provider: "openai", sdkId: "gpt-5.4", label: "gpt-5.4", contextWindow: 256_000 },
  { id: "gemini-2.5-pro", provider: "google", sdkId: "gemini-2.5-pro", label: "gemini-2.5-pro", contextWindow: 1_000_000 },
  { id: "gemini-2.5-flash", provider: "google", sdkId: "gemini-2.5-flash", label: "gemini-flash", contextWindow: 1_000_000 },
  { id: "deepseek-chat", provider: "deepseek", sdkId: "deepseek-chat", label: "deepseek", contextWindow: 128_000 },
];

const ENV_KEY: Record<ProviderId, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
};

export function providerAvailable(p: ProviderId): boolean {
  return Boolean(process.env[ENV_KEY[p]]);
}

export function findModel(idOrLabel: string): ModelSpec | undefined {
  return MODELS.find((m) => m.id === idOrLabel || m.label === idOrLabel);
}

export function resolveModel(spec: ModelSpec): LanguageModel {
  switch (spec.provider) {
    case "anthropic":
      return anthropic(spec.sdkId);
    case "openai":
      return openai(spec.sdkId);
    case "google":
      return google(spec.sdkId);
    case "deepseek":
      return deepseek(spec.sdkId);
  }
}
