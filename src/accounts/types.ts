// Accounts — a credential + the provider it authenticates + how it executes.
// MANY accounts per provider (two Anthropic keys, a work AWS, a personal Max
// plan). Secret VALUES never live in an Account — only `ref` keys into the
// secret store (src/accounts/store.ts). This is the data the onboarding flow
// fills and the resolver reads; it is deliberately provider-agnostic so adding
// a provider is data, not code (CLAUDE.md).

// in-loop = runs inside Gearbox's own agent loop via the AI SDK (our tools,
// our permission gate, our context engine). cli = a subprocess to the vendor's
// official binary (claude/codex) which runs ITS OWN loop/tools/permissions —
// the ToS-clean way to use a Pro/Max/Plus subscription (never token extraction).
export type ExecMode = "in-loop" | "cli";

export type AuthMethod =
  | { kind: "api-key"; ref: string; organization?: string; project?: string }
  | { kind: "aws"; accessKeyIdRef: string; secretKeyRef: string; sessionTokenRef?: string; region: string; profile?: string }
  | { kind: "azure"; resourceName: string; ref: string; apiVersion?: string }
  | { kind: "vertex"; project: string; location: string; serviceAccountRef?: string; adc?: boolean }
  | { kind: "openai-compat"; ref: string } // baseUrl carried on the Account
  | { kind: "cli"; binary: string; loginProfile?: string }; // binary is an open string

export type AuthKind = AuthMethod["kind"];

export interface Account {
  id: string; // stable, e.g. "anthropic-work"
  slug?: string; // stable human reference for /account <slug>; unique across accounts
  label: string; // human-facing, e.g. "Anthropic (work)"
  provider: string; // catalog provider id, e.g. "anthropic", "openrouter", "claude-cli"
  exec: ExecMode;
  auth: AuthMethod;
  models?: string[]; // which models this account can serve (esp. for cli accounts)
  baseUrl?: string; // openai-compat / gateway endpoint override
  extraHeaders?: Record<string, string>; // gateways (e.g. OpenRouter referer/title)
  identity?: { key: string; label?: string; checkedAt: number }; // provider-exposed signed-in identity, when available
  enabled: boolean;
  addedAt: number;
  lastUsedAt?: number;
}

// The non-secret registry persisted at ~/.gearbox/accounts.json.
export interface AccountsFile {
  version: 1;
  accounts: Account[];
  defaults: Record<string, string>; // provider -> account id (the active one)
}

// Resolved credentials handed to providers.resolveModel (kept out of the SDK
// seam so providers.ts never touches the store). Secrets fetched on demand.
// Cloud providers carry richer config than a single key.
export interface ResolvedCreds {
  apiKey?: string;
  baseURL?: string;
  headers?: Record<string, string>;
  aws?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string; region: string };
  azure?: { resourceName: string; apiKey: string; apiVersion?: string };
  vertex?: { project: string; location: string; credentials?: Record<string, unknown> };
}
