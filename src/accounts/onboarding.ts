// Onboarding helpers: alias normalization, provider lists, and the first-run
// summary text. Kept separate from onboard.ts (which does I/O) so these pure
// functions are testable without side effects.
import { CATALOG, catalogProvider, type CatalogProvider } from "./catalog.ts";
import type { Account } from "./types.ts";

const ALIASES: Record<string, string> = {
  anthropic: "anthropic",
  claude: "anthropic",
  openai: "openai",
  gpt: "openai",
  google: "google",
  gemini: "google",
  deepseek: "deepseek",
  grok: "xai",
  xai: "xai",
  "x-ai": "xai",
  mistral: "mistral",
  groq: "groq",
  together: "together",
  fireworks: "fireworks",
  deepinfra: "deepinfra",
  cerebras: "cerebras",
  perplexity: "perplexity",
  baseten: "baseten",
  moonshot: "moonshot",
  kimi: "moonshot",
  zai: "zai",
  zhipu: "zai",
  nebius: "nebius",
  hyperbolic: "hyperbolic",
  sambanova: "sambanova",
  novita: "novita",
  openrouter: "openrouter",
  requesty: "requesty",
  portkey: "portkey",
  litellm: "litellm",
  "vercel-gateway": "vercel-gateway",
  vercel: "vercel-gateway",
  "ai-gateway": "vercel-gateway",
  azure: "azure",
  "azure-foundry": "azure-foundry",
  foundry: "azure-foundry",
};

const FEATURED = [
  "anthropic",
  "openai",
  "google",
  "deepseek",
  "openrouter",
  "xai",
  "mistral",
  "groq",
  "together",
  "fireworks",
  "perplexity",
  "cerebras",
  "requesty",
];

export function normalizeProviderId(input: string): string {
  const key = input.trim().toLowerCase().replace(/[_\s]+/g, "-");
  return ALIASES[key] ?? key;
}

export function providerForInput(input: string): CatalogProvider | undefined {
  return catalogProvider(normalizeProviderId(input));
}

export function apiKeyProviders(): CatalogProvider[] {
  return CATALOG.filter((p) =>
    (p.authKind === "api-key" || p.authKind === "openai-compat") &&
    p.group !== "local" &&
    (p.authKind !== "openai-compat" || Boolean(p.baseUrl))
  );
}

export function featuredApiKeyProviders(): CatalogProvider[] {
  const providers = apiKeyProviders();
  const byId = new Map(providers.map((p) => [p.id, p]));
  const first = FEATURED.map((id) => byId.get(id)).filter((p): p is CatalogProvider => Boolean(p));
  const rest = providers.filter((p) => !FEATURED.includes(p.id)).sort((a, b) => a.label.localeCompare(b.label));
  return [...first, ...rest];
}

export interface OnboardingState {
  configured: Account[];
  importable: { provider: string; label: string; envVar: string }[];
  cloudImportable: { provider: string; label: string; source: string }[];
  hasClaudeCli: boolean;
  hasCodexCli: boolean;
}

export function needsOnboarding(state: Pick<OnboardingState, "configured">): boolean {
  return state.configured.length === 0;
}

export function onboardingSummary(state: OnboardingState): string {
  if (!needsOnboarding(state)) return "ready";
  const lines = [
    "setup required",
    "  Add any common provider API key:",
    ...featuredApiKeyProviders().slice(0, 10).map((p) => `  /account add ${p.id} <api-key>`.padEnd(38) + `${p.label}`),
  ];
  const more = featuredApiKeyProviders().length - 10;
  if (more > 0) lines.push(`  /onboard providers                    show ${more} more providers`);
  if (state.importable.length || state.cloudImportable.length) lines.push("", "  /account import                       import detected env/cloud credentials");
  lines.push("  /account add azure <endpoint> <api-key>  Azure OpenAI / Foundry");
  if (state.hasClaudeCli) lines.push("  /account add claude                   use Claude subscription CLI");
  if (state.hasCodexCli) lines.push("  /account add codex                    use ChatGPT subscription CLI");
  lines.push("", "Paste-detect works for known key prefixes: /account add <api-key>");
  return lines.join("\n");
}
