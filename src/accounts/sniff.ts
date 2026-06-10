// Identify a pasted credential — API key, AWS access key or credentials block,
// service-account JSON, Azure endpoint, gateway key — so /account add can route
// it and ask only for what's missing. Pure + tested. Detection only; no I/O.
import { detectProviderByKey, catalogProvider } from "./catalog.ts";
import type { AuthKind } from "./types.ts";

export interface CredentialGuess {
  kind: AuthKind | "unknown";
  provider?: string;
  fields: Record<string, string>;
  missing: string[];
  confidence: "high" | "low";
}

const AWS_KEY_RE = /\b((?:AKIA|ASIA)[A-Z0-9]{16})\b/;

export function sniffCredential(text: string): CredentialGuess {
  const t = text.trim();

  // 1) Service-account JSON (Vertex).
  if (/^\s*\{/.test(t) && /"type"\s*:\s*"service_account"/.test(t)) {
    try {
      const j = JSON.parse(t);
      return {
        kind: "vertex",
        provider: "vertex",
        fields: { project: j.project_id ?? "", serviceAccountJson: t },
        missing: j.project_id ? ["location"] : ["project", "location"],
        confidence: "high",
      };
    } catch {
      return {
        kind: "vertex",
        provider: "vertex",
        fields: { serviceAccountJson: t },
        missing: ["project", "location"],
        confidence: "low",
      };
    }
  }

  // 2) Azure / Foundry endpoint URL. Classic resources live on
  // *.openai.azure.com; services.ai.azure.com / cognitiveservices.azure.com
  // hosts are Foundry/AI-services endpoints — a classic account minted from
  // one builds a broken base URL, so tag the right provider. The kind stays
  // "azure" so the guided message routes to `/account add azure <endpoint>
  // <key>`, which delegates URL-shaped Foundry endpoints itself.
  const azure = t.match(
    /https?:\/\/([a-z0-9-]+)\.(openai\.azure\.com|cognitiveservices\.azure\.com|services\.ai\.azure\.com)/i,
  );
  if (azure) {
    return {
      kind: "azure",
      provider: /^openai\.azure\.com$/i.test(azure[2]!) ? "azure" : "azure-foundry",
      fields: { resourceName: azure[1]!, endpoint: t },
      missing: ["apiKey"],
      confidence: "high",
    };
  }

  // 3) AWS credentials block (key=value lines).
  if (/aws_access_key_id\s*=/.test(t) || (AWS_KEY_RE.test(t) && /aws_secret_access_key|secret/i.test(t))) {
    const id = t.match(AWS_KEY_RE)?.[1] ?? "";
    const secret = t.match(/aws_secret_access_key\s*=\s*([A-Za-z0-9/+=]+)/i)?.[1] ?? "";
    const region = t.match(/(?:aws_)?region\s*=\s*([a-z0-9-]+)/i)?.[1] ?? "";
    const missing: string[] = [];
    // A credentials block can name the field without a recognizable AKIA/ASIA
    // value (truncated paste, exotic key class) — an empty id silently produced
    // a broken bedrock account because it was never listed as missing.
    if (!id) missing.push("accessKeyId");
    if (!secret) missing.push("secretAccessKey");
    if (!region) missing.push("region");
    return {
      kind: "aws",
      provider: "bedrock",
      fields: { accessKeyId: id, secretAccessKey: secret, region },
      missing,
      confidence: "high",
    };
  }

  // 4) Bare AWS access key id.
  const awsId = t.match(/^((?:AKIA|ASIA)[A-Z0-9]{16})$/)?.[1];
  if (awsId) {
    return {
      kind: "aws",
      provider: "bedrock",
      fields: { accessKeyId: awsId },
      missing: ["secretAccessKey", "region"],
      confidence: "high",
    };
  }

  // 5) Vercel AI Gateway key.
  if (/^vck_/.test(t)) {
    return {
      kind: "openai-compat",
      provider: "vercel-gateway",
      fields: { apiKey: t },
      missing: [],
      confidence: "high",
    };
  }

  // 6) Known API-key prefixes (anthropic, openai, google, openrouter, groq, …).
  const provider = detectProviderByKey(t);
  if (provider) {
    const cat = catalogProvider(provider);
    const kind: AuthKind = cat?.authKind === "openai-compat" ? "openai-compat" : "api-key";
    return { kind, provider, fields: { apiKey: t }, missing: [], confidence: "high" };
  }

  // 7) Unknown.
  return { kind: "unknown", fields: { apiKey: t }, missing: ["provider"], confidence: "low" };
}
