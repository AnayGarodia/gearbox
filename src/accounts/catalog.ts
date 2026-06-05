// The provider catalog — the full map of who Gearbox can talk to, as DATA.
// Adding a provider is a row here, not code (CLAUDE.md). Onboarding reads this
// for guided add + paste-detection; resolve.ts reads `group`/`baseUrl` to build
// the right client. Most providers are OpenAI-wire-compatible, so they need no
// dedicated SDK — just `createOpenAI({ baseURL })` (see resolve.ts).
import type { AuthKind, ExecMode } from "./types.ts";

export type ProviderGroup =
  | "native" // first-party AI SDK package (anthropic, google, deepseek, openai)
  | "openai-compat" // talk via the OpenAI wire protocol + a baseUrl
  | "gateway" // multi-provider aggregator (OpenAI-compatible)
  | "cloud" // AWS/GCP/Azure credential chains
  | "local" // localhost OpenAI-compatible server
  | "cli"; // subprocess to a vendor binary (subscription)

export interface CatalogProvider {
  id: string;
  label: string;
  group: ProviderGroup;
  exec: ExecMode;
  authKind: AuthKind;
  envVars: string[]; // env vars we import from / fall back to
  keyPrefix?: string[]; // for paste-and-detect (e.g. ["sk-ant-"])
  baseUrl?: string; // openai-compat / gateway / local endpoint
  signupUrl?: string;
  defaultModels?: string[]; // a few well-known model ids (seeds; not the full list)
  binary?: string; // for cli group
  notes?: string;
}

export const CATALOG: CatalogProvider[] = [
  // ── native (first-party AI SDK packages already installed) ──
  { id: "anthropic", label: "Anthropic", group: "native", exec: "in-loop", authKind: "api-key", envVars: ["ANTHROPIC_API_KEY"], keyPrefix: ["sk-ant-"], signupUrl: "https://console.anthropic.com/settings/keys", defaultModels: ["claude-sonnet-4-6", "claude-haiku-4-5", "claude-opus-4-8"] },
  { id: "openai", label: "OpenAI", group: "native", exec: "in-loop", authKind: "api-key", envVars: ["OPENAI_API_KEY"], keyPrefix: ["sk-proj-", "sk-"], signupUrl: "https://platform.openai.com/api-keys", defaultModels: ["gpt-5.5", "gpt-5.5-pro", "gpt-5.5-mini"] },
  { id: "google", label: "Google Gemini", group: "native", exec: "in-loop", authKind: "api-key", envVars: ["GOOGLE_GENERATIVE_AI_API_KEY", "GEMINI_API_KEY"], keyPrefix: ["AIza"], signupUrl: "https://aistudio.google.com/apikey", defaultModels: ["gemini-3.5-flash", "gemini-3.1-pro-preview", "gemini-3.1-flash-lite"] },
  { id: "deepseek", label: "DeepSeek", group: "native", exec: "in-loop", authKind: "api-key", envVars: ["DEEPSEEK_API_KEY"], baseUrl: "https://api.deepseek.com/v1", signupUrl: "https://platform.deepseek.com/api_keys", defaultModels: ["deepseek-v4-pro", "deepseek-v4-flash"] },

  // ── direct API, OpenAI-wire-compatible (no dedicated package needed) ──
  { id: "xai", label: "xAI (Grok)", group: "openai-compat", exec: "in-loop", authKind: "openai-compat", envVars: ["XAI_API_KEY"], keyPrefix: ["xai-"], baseUrl: "https://api.x.ai/v1", signupUrl: "https://console.x.ai", defaultModels: ["grok-4.3", "grok-4.1-fast"] },
  { id: "mistral", label: "Mistral", group: "openai-compat", exec: "in-loop", authKind: "openai-compat", envVars: ["MISTRAL_API_KEY"], baseUrl: "https://api.mistral.ai/v1", signupUrl: "https://console.mistral.ai/api-keys", defaultModels: ["mistral-large-latest", "codestral-latest"] },
  { id: "groq", label: "Groq", group: "openai-compat", exec: "in-loop", authKind: "openai-compat", envVars: ["GROQ_API_KEY"], keyPrefix: ["gsk_"], baseUrl: "https://api.groq.com/openai/v1", signupUrl: "https://console.groq.com/keys", defaultModels: ["llama-3.3-70b-versatile", "moonshotai/kimi-k2-instruct"] },
  { id: "together", label: "Together AI", group: "openai-compat", exec: "in-loop", authKind: "openai-compat", envVars: ["TOGETHER_API_KEY"], baseUrl: "https://api.together.xyz/v1", signupUrl: "https://api.together.ai/settings/api-keys", defaultModels: ["deepseek-ai/DeepSeek-V3", "Qwen/Qwen2.5-Coder-32B-Instruct"] },
  { id: "fireworks", label: "Fireworks", group: "openai-compat", exec: "in-loop", authKind: "openai-compat", envVars: ["FIREWORKS_API_KEY"], keyPrefix: ["fw_"], baseUrl: "https://api.fireworks.ai/inference/v1", signupUrl: "https://fireworks.ai/account/api-keys", defaultModels: ["accounts/fireworks/models/deepseek-v3"] },
  { id: "deepinfra", label: "DeepInfra", group: "openai-compat", exec: "in-loop", authKind: "openai-compat", envVars: ["DEEPINFRA_API_KEY"], baseUrl: "https://api.deepinfra.com/v1/openai", signupUrl: "https://deepinfra.com/dash/api_keys" },
  { id: "cerebras", label: "Cerebras", group: "openai-compat", exec: "in-loop", authKind: "openai-compat", envVars: ["CEREBRAS_API_KEY"], keyPrefix: ["csk-"], baseUrl: "https://api.cerebras.ai/v1", signupUrl: "https://cloud.cerebras.ai", defaultModels: ["qwen-3-coder-480b", "llama-3.3-70b"] },
  { id: "perplexity", label: "Perplexity", group: "openai-compat", exec: "in-loop", authKind: "openai-compat", envVars: ["PERPLEXITY_API_KEY"], keyPrefix: ["pplx-"], baseUrl: "https://api.perplexity.ai", signupUrl: "https://www.perplexity.ai/settings/api", defaultModels: ["sonar-pro", "sonar-reasoning-pro"] },
  { id: "baseten", label: "Baseten", group: "openai-compat", exec: "in-loop", authKind: "openai-compat", envVars: ["BASETEN_API_KEY"], baseUrl: "https://inference.baseten.co/v1", signupUrl: "https://app.baseten.co/settings/api_keys" },
  { id: "moonshot", label: "Moonshot (Kimi)", group: "openai-compat", exec: "in-loop", authKind: "openai-compat", envVars: ["MOONSHOT_API_KEY"], baseUrl: "https://api.moonshot.ai/v1", signupUrl: "https://platform.moonshot.ai/console/api-keys", defaultModels: ["kimi-k2-0905-preview"] },
  { id: "zai", label: "Z.ai (GLM)", group: "openai-compat", exec: "in-loop", authKind: "openai-compat", envVars: ["ZAI_API_KEY", "ZHIPU_API_KEY"], baseUrl: "https://api.z.ai/api/paas/v4", signupUrl: "https://z.ai/manage-apikey/apikey-list", defaultModels: ["glm-4.6", "glm-4.5-air"] },
  { id: "nebius", label: "Nebius AI Studio", group: "openai-compat", exec: "in-loop", authKind: "openai-compat", envVars: ["NEBIUS_API_KEY"], baseUrl: "https://api.studio.nebius.com/v1", signupUrl: "https://studio.nebius.com" },
  { id: "hyperbolic", label: "Hyperbolic", group: "openai-compat", exec: "in-loop", authKind: "openai-compat", envVars: ["HYPERBOLIC_API_KEY"], baseUrl: "https://api.hyperbolic.xyz/v1", signupUrl: "https://app.hyperbolic.xyz/settings" },
  { id: "sambanova", label: "SambaNova", group: "openai-compat", exec: "in-loop", authKind: "openai-compat", envVars: ["SAMBANOVA_API_KEY"], baseUrl: "https://api.sambanova.ai/v1", signupUrl: "https://cloud.sambanova.ai/apis" },
  { id: "novita", label: "Novita", group: "openai-compat", exec: "in-loop", authKind: "openai-compat", envVars: ["NOVITA_API_KEY"], baseUrl: "https://api.novita.ai/v3/openai", signupUrl: "https://novita.ai/settings/key-management" },

  // ── gateways / aggregators (OpenAI-compatible; one key, many models) ──
  { id: "openrouter", label: "OpenRouter", group: "gateway", exec: "in-loop", authKind: "openai-compat", envVars: ["OPENROUTER_API_KEY"], keyPrefix: ["sk-or-"], baseUrl: "https://openrouter.ai/api/v1", signupUrl: "https://openrouter.ai/keys", notes: "Hundreds of models via one key. extraHeaders HTTP-Referer/X-Title recommended." },
  { id: "vercel-gateway", label: "Vercel AI Gateway", group: "gateway", exec: "in-loop", authKind: "openai-compat", envVars: ["AI_GATEWAY_API_KEY"], baseUrl: "https://ai-gateway.vercel.sh/v1", signupUrl: "https://vercel.com/docs/ai-gateway", notes: "Spend + credit telemetry; feeds the future ACCOUNT pillar." },
  { id: "requesty", label: "Requesty", group: "gateway", exec: "in-loop", authKind: "openai-compat", envVars: ["REQUESTY_API_KEY"], baseUrl: "https://router.requesty.ai/v1", signupUrl: "https://app.requesty.ai" },
  { id: "portkey", label: "Portkey", group: "gateway", exec: "in-loop", authKind: "openai-compat", envVars: ["PORTKEY_API_KEY"], baseUrl: "https://api.portkey.ai/v1", signupUrl: "https://app.portkey.ai", notes: "Config-driven routing via x-portkey-* headers." },
  { id: "litellm", label: "LiteLLM proxy", group: "gateway", exec: "in-loop", authKind: "openai-compat", envVars: ["LITELLM_API_KEY"], signupUrl: "https://docs.litellm.ai/docs/simple_proxy", notes: "Self-hosted; set baseUrl to your proxy." },
  { id: "azure-foundry", label: "Azure AI Foundry", group: "gateway", exec: "in-loop", authKind: "openai-compat", envVars: ["AZURE_AI_FOUNDRY_API_KEY", "AZURE_AI_INFERENCE_API_KEY"], signupUrl: "https://ai.azure.com", defaultModels: ["gpt-5.5", "gpt-5.5-mini", "gpt-4.1", "o4-mini"], notes: "OpenAI-compatible Foundry endpoint. Use baseUrl ending in /openai/v1." },

  // ── cloud (credential chains; native packages added in P2) ──
  { id: "bedrock", label: "Amazon Bedrock", group: "cloud", exec: "in-loop", authKind: "aws", envVars: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION", "AWS_PROFILE"], keyPrefix: ["AKIA", "ASIA"], signupUrl: "https://console.aws.amazon.com/bedrock", defaultModels: ["anthropic.claude-sonnet-4-20250514-v1:0"], notes: "Needs @ai-sdk/amazon-bedrock (P2)." },
  { id: "vertex", label: "Google Vertex AI", group: "cloud", exec: "in-loop", authKind: "vertex", envVars: ["GOOGLE_VERTEX_PROJECT", "GOOGLE_VERTEX_LOCATION", "GOOGLE_APPLICATION_CREDENTIALS"], signupUrl: "https://console.cloud.google.com/vertex-ai", defaultModels: ["gemini-3.1-pro-preview"], notes: "ADC or a service-account JSON." },
  { id: "azure", label: "Azure OpenAI", group: "cloud", exec: "in-loop", authKind: "azure", envVars: ["AZURE_API_KEY", "AZURE_RESOURCE_NAME"], signupUrl: "https://oai.azure.com", notes: "Needs @ai-sdk/azure (P2); resourceName + deployment." },

  // ── local (OpenAI-compatible servers; usually no key) ──
  { id: "ollama", label: "Ollama (local)", group: "local", exec: "in-loop", authKind: "openai-compat", envVars: [], baseUrl: "http://localhost:11434/v1", signupUrl: "https://ollama.com", defaultModels: ["qwen2.5-coder:7b", "llama3.3"], notes: "No key; runs on your machine." },
  { id: "lmstudio", label: "LM Studio (local)", group: "local", exec: "in-loop", authKind: "openai-compat", envVars: [], baseUrl: "http://localhost:1234/v1", signupUrl: "https://lmstudio.ai" },
  { id: "vllm", label: "vLLM (local/self-host)", group: "local", exec: "in-loop", authKind: "openai-compat", envVars: [], baseUrl: "http://localhost:8000/v1", signupUrl: "https://docs.vllm.ai" },
  { id: "llamacpp", label: "llama.cpp (local)", group: "local", exec: "in-loop", authKind: "openai-compat", envVars: [], baseUrl: "http://localhost:8080/v1", signupUrl: "https://github.com/ggml-org/llama.cpp" },

  // ── CLI-backed subscriptions (subprocess; never token extraction) ──
  { id: "claude-cli", label: "Claude (Pro/Max via claude CLI)", group: "cli", exec: "cli", authKind: "cli", envVars: [], binary: "claude", signupUrl: "https://claude.com/product/claude-code", defaultModels: ["claude-opus-4-8", "claude-sonnet-4-6"], notes: "Wraps the official binary (like Conductor). Runs its own tools/permissions. ToS-clean: no token is read." },
  { id: "codex-cli", label: "ChatGPT (Plus/Pro via codex CLI)", group: "cli", exec: "cli", authKind: "cli", envVars: [], binary: "codex", signupUrl: "https://developers.openai.com/codex/cli", defaultModels: ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini"], notes: "Wraps the official binary. Runs its own tools/permissions. ToS-clean." },
];

const BY_ID = new Map(CATALOG.map((p) => [p.id, p]));
export function catalogProvider(id: string): CatalogProvider | undefined {
  return BY_ID.get(id);
}

/** Best-effort provider id from a pasted API key prefix (for paste-and-detect). */
export function detectProviderByKey(key: string): string | undefined {
  const k = key.trim();
  // Longest/most-specific prefixes first so "sk-ant-"/"sk-or-" beat bare "sk-".
  const ranked = CATALOG.flatMap((p) => (p.keyPrefix ?? []).map((pre) => ({ id: p.id, pre })))
    .sort((a, b) => b.pre.length - a.pre.length);
  return ranked.find(({ pre }) => k.startsWith(pre))?.id;
}
