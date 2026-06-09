// The add-account SPEC — one data-driven description, per addable provider, of
// exactly what fields a credential needs. Single source of truth shared by three
// surfaces so they never drift:
//   (a) the guided wizard (src/ui/panel.ts + components/Panel.tsx) — one step per field,
//   (b) the live command palette (App.tsx commandPickerRows),
//   (c) the rich error/guidance text when a typed `/account add …` is wrong.
// Pure + tested. The only async bit is build(), which just delegates to the
// existing addX functions in onboard.ts (no new credential logic here). DATA, not
// code, per CLAUDE.md — adding a provider is a row, not a new branch.
import { catalogProvider } from "./catalog.ts";
import {
  addApiKeyAccount,
  addAzureAccount,
  addAzureFoundryAccount,
  addBedrockAccount,
  addVertexAccount,
  addOpenAICompatAccount,
  type AddResult,
} from "./onboard.ts";

export interface FieldSpec {
  key: string; // build() reads fields[key]
  label: string; // step header in the wizard
  placeholder: string; // shown faint under the input ("e.g. …")
  required: boolean;
  secret?: boolean; // API keys: shown as typed (local terminal); summarised masked
  validate(v: string): string | null; // null = ok, string = inline error
}

export interface AddSpec {
  id: string; // unique; wizard routing + palette value
  label: string; // "Azure OpenAI"
  summary: string; // one-line palette/pick detail
  group: "subscription" | "api-key" | "cloud" | "compat";
  signupUrl?: string; // from CATALOG; "get a key →" link
  fields: FieldSpec[]; // empty for subscriptions (sign-in only)
  paletteCommand: string; // inserted when the palette row is picked
  build(fields: Record<string, string>): Promise<AddResult>;
}

const required = (v: string): string | null => (v.trim() ? null : "required");
const urlOk = (v: string): string | null => (/^https?:\/\//i.test(v.trim()) ? null : "must start with http(s)://");

// A "paste an API key" spec for any catalog provider that addApiKeyAccount can
// take with just a key (native api-key providers, or openai-compat with a built-in baseUrl).
function apiKeySpec(providerId: string): AddSpec {
  const cat = catalogProvider(providerId);
  const label = cat?.label ?? providerId;
  const example = cat?.keyPrefix?.length ? `${cat.keyPrefix[0]}…` : "your API key";
  return {
    id: providerId,
    label,
    summary: "paste an API key",
    group: "api-key",
    signupUrl: cat?.signupUrl,
    paletteCommand: `/account add ${providerId}`,
    fields: [{ key: "apiKey", label: `${label} API key`, placeholder: example, required: true, secret: true, validate: required }],
    build: (f) => addApiKeyAccount(providerId, f.apiKey ?? ""),
  };
}

function subscriptionSpec(id: string, label: string, summary: string): AddSpec {
  const word = id.replace("-subscription", "");
  return {
    id,
    label,
    summary,
    group: "subscription",
    signupUrl: catalogProvider(`${word}-cli`)?.signupUrl,
    paletteCommand: `/account add ${word}`,
    fields: [],
    // Subscriptions sign in via the vendor CLI; the App key-handler routes them to
    // signInCli before calling build(). This is only a safety fallback.
    build: async () => ({ ok: false, message: `use /account add ${word} to sign in` }),
  };
}

// The curated, ordered list shown in the wizard pick-list and the palette. Common
// providers first. specFor() also resolves anything in CATALOG (see below), so the
// command path and guidance cover providers beyond this list too.
export const ADD_SPECS: AddSpec[] = [
  apiKeySpec("anthropic"),
  apiKeySpec("openai"),
  apiKeySpec("google"),
  subscriptionSpec("claude-subscription", "Claude Pro / Max", "sign in via the claude CLI"),
  subscriptionSpec("codex-subscription", "ChatGPT Plus / Pro", "sign in via the codex CLI"),
  apiKeySpec("openrouter"),
  apiKeySpec("deepseek"),
  apiKeySpec("groq"),
  apiKeySpec("xai"),
  {
    id: "azure",
    label: "Azure OpenAI",
    summary: "resource name + API key",
    group: "cloud",
    signupUrl: catalogProvider("azure")?.signupUrl,
    paletteCommand: "/account add azure",
    fields: [
      { key: "resource", label: "Resource name or endpoint", placeholder: "my-resource  (or https://my-resource.openai.azure.com)", required: true, validate: required },
      { key: "apiKey", label: "API key", placeholder: "your Azure OpenAI key", required: true, secret: true, validate: (v) => (v.trim().length >= 8 ? null : "key looks too short") },
      { key: "apiVersion", label: "API version (optional)", placeholder: "2024-08-01-preview  —  blank for default", required: false, validate: () => null },
    ],
    build: (f) => addAzureAccount(f.resource ?? "", f.apiKey ?? "", { apiVersion: f.apiVersion || undefined }),
  },
  {
    id: "azure-foundry",
    label: "Azure AI Foundry",
    summary: "full https:// endpoint + key",
    group: "cloud",
    signupUrl: catalogProvider("azure-foundry")?.signupUrl,
    paletteCommand: "/account add azure",
    fields: [
      { key: "endpoint", label: "Foundry endpoint", placeholder: "https://my-hub.services.ai.azure.com", required: true, validate: urlOk },
      { key: "apiKey", label: "API key", placeholder: "your Foundry key", required: true, secret: true, validate: required },
    ],
    build: (f) => addAzureFoundryAccount(f.endpoint ?? "", f.apiKey ?? ""),
  },
  {
    id: "bedrock",
    label: "Amazon Bedrock",
    summary: "AWS key + secret + region",
    group: "cloud",
    signupUrl: catalogProvider("bedrock")?.signupUrl,
    paletteCommand: "/account add bedrock",
    fields: [
      { key: "accessKeyId", label: "AWS Access Key ID", placeholder: "AKIAIOSFODNN7EXAMPLE", required: true, validate: (v) => (/^(AKIA|ASIA)[A-Z0-9]{16}$/.test(v.trim()) ? null : "should start with AKIA or ASIA") },
      { key: "secretAccessKey", label: "AWS Secret Access Key", placeholder: "wJalrXUtnFEMI/K7MDENG/…EXAMPLEKEY", required: true, secret: true, validate: (v) => (v.trim().length >= 16 ? null : "too short") },
      { key: "region", label: "AWS Region", placeholder: "us-east-1", required: true, validate: (v) => (/^[a-z]{2}-[a-z]+-\d$/.test(v.trim()) ? null : "e.g. us-east-1") },
    ],
    build: (f) => addBedrockAccount(f.accessKeyId ?? "", f.secretAccessKey ?? "", f.region ?? ""),
  },
  {
    id: "vertex",
    label: "Google Vertex AI",
    summary: "GCP project + location + ADC or SA JSON",
    group: "cloud",
    signupUrl: catalogProvider("vertex")?.signupUrl,
    paletteCommand: "/account add vertex",
    fields: [
      { key: "project", label: "GCP Project ID", placeholder: "my-gcp-project-123", required: true, validate: required },
      { key: "location", label: "Location (region)", placeholder: "us-central1", required: true, validate: required },
      {
        key: "serviceAccountJson",
        label: "Service account JSON (optional — blank uses gcloud ADC)",
        placeholder: "paste the JSON key file contents, or press ⏎ to use ADC",
        required: false,
        secret: true,
        validate: (v) => {
          if (!v.trim()) return null;
          try {
            JSON.parse(v);
            return null;
          } catch {
            return "not valid JSON";
          }
        },
      },
    ],
    build: (f) => addVertexAccount(f.project ?? "", f.location ?? "", f.serviceAccountJson || undefined),
  },
  {
    id: "openai-compat",
    label: "OpenAI-compatible endpoint",
    summary: "LiteLLM · proxy · self-hosted",
    group: "compat",
    signupUrl: catalogProvider("litellm")?.signupUrl,
    paletteCommand: "/account add openai-compat",
    fields: [
      { key: "name", label: "Name", placeholder: "my-proxy", required: true, validate: required },
      { key: "baseUrl", label: "Base URL", placeholder: "https://my-proxy.example.com/v1", required: true, validate: urlOk },
      { key: "apiKey", label: "API key (blank if none)", placeholder: "your key, or ⏎ to skip", required: false, secret: true, validate: () => null },
      { key: "models", label: "Model ids (space-separated)", placeholder: "gpt-4o  llama-3.3-70b", required: true, validate: (v) => (v.trim() ? null : "at least one model id") },
    ],
    build: (f) => addOpenAICompatAccount(f.name ?? "", f.baseUrl ?? "", f.apiKey ?? "", (f.models ?? "").trim().split(/\s+/).filter(Boolean)),
  },
];

// Aliases the typed command accepts → the spec that explains them.
const ALIAS: Record<string, string> = {
  aws: "bedrock",
  chatgpt: "codex-subscription",
  codex: "codex-subscription",
  "codex-cli": "codex-subscription",
  claude: "claude-subscription",
  "claude-cli": "claude-subscription",
  "openai-compatible": "openai-compat",
  custom: "openai-compat",
  proxy: "openai-compat",
  foundry: "azure-foundry",
};

/** Resolve a provider token (or alias) to its add spec. Falls back to a
 *  synthesized "paste a key" spec for any catalog provider not in the curated
 *  list, so guidance + the command path cover everything. Undefined if unknown. */
export function specFor(idOrAlias: string): AddSpec | undefined {
  const id = ALIAS[idOrAlias.toLowerCase()] ?? idOrAlias.toLowerCase();
  const found = ADD_SPECS.find((s) => s.id === id);
  if (found) return found;
  const cat = catalogProvider(id);
  if (cat && cat.group !== "cli") {
    if (cat.authKind === "api-key" || (cat.authKind === "openai-compat" && cat.baseUrl)) return apiKeySpec(id);
    if (cat.authKind === "openai-compat") return ADD_SPECS.find((s) => s.id === "openai-compat");
  }
  return undefined;
}

/** Filter the curated specs by a query (substring on id/label/summary). */
export function filterAddSpecs(query: string): AddSpec[] {
  const q = query.trim().toLowerCase();
  if (!q) return ADD_SPECS;
  return ADD_SPECS.filter((s) => s.id.includes(q) || s.label.toLowerCase().includes(q) || s.summary.toLowerCase().includes(q));
}

export interface PaletteAddRow {
  label: string;
  detail: string;
  command: string;
}

/** Palette rows for `/account add …`, derived from the curated specs (+ second
 *  subscription account quick-starts + a generic paste row). */
export function buildPaletteAddRows(): PaletteAddRow[] {
  const rows: PaletteAddRow[] = [];
  for (const s of ADD_SPECS) {
    rows.push({ label: s.paletteCommand.replace(/^\/account /, ""), detail: s.summary, command: s.paletteCommand });
    if (s.group === "subscription") {
      const word = s.id.replace("-subscription", "");
      rows.push({ label: `add ${word} work`, detail: `a 2nd ${s.label} account`, command: `/account add ${word} work` });
    }
  }
  rows.push({ label: "add", detail: "paste any key / block / JSON — auto-detected", command: "/account add" });
  return rows;
}

/** A rich, multi-line guidance block for a wrong/incomplete `/account add …`.
 *  Shows the raw failure, the fields the provider needs (with examples), a signup
 *  link, the Azure Foundry/classic disambiguation, and the wizard escape hatch.
 *  For an unknown provider, lists the available providers instead. */
export function buildAddGuidance(providerOrSpecId: string, rawMessage: string): string {
  const spec = specFor(providerOrSpecId);
  if (!spec) {
    const choices = ADD_SPECS.map((s) => `  ${s.paletteCommand.padEnd(34)}${s.summary}`).join("\n");
    return `${rawMessage}\n\nadd an account — pick a provider:\n${choices}\n\nor run /account → "+ Add an account" for a guided setup.`;
  }
  const lines: string[] = [rawMessage, "", `${spec.label} needs:`];
  for (const f of spec.fields) {
    const tag = f.required ? "" : " (optional)";
    lines.push(`  ${(f.label.replace(/ \(optional.*\)$/, "") + tag).padEnd(30)}e.g. ${f.placeholder}`);
  }
  if (spec.id === "azure") {
    lines.push(
      "",
      "Azure OpenAI vs Foundry:",
      "  Classic:  /account add azure my-resource <key>",
      "  Foundry:  /account add azure https://my-hub.services.ai.azure.com <key>",
    );
  }
  if (spec.signupUrl) lines.push("", `Get a key → ${spec.signupUrl}`);
  lines.push("", `Or skip the syntax: /account → "+ Add an account" → ${spec.label}`);
  return lines.join("\n");
}
