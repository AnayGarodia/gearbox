// Detect credentials already on the machine and import them as accounts — so
// existing users get instant value without re-entering keys (the highest-leverage
// onboarding move). P0 covers environment variables (the path that worked before).
// P1 extends this to ~/.aws/credentials, gcloud ADC, and `claude`/`codex` login
// detection (the latter registering a cli account — never reading a token).
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { CATALOG } from "./catalog.ts";
import { putAccount, setSecret, getAccount } from "./store.ts";
import type { Account } from "./types.ts";

export interface DetectedCred {
  provider: string;
  label: string;
  envVar: string;
  value: string;
}

/** API/openai-compat provider keys present in the environment. One per provider. */
export function detectEnvCreds(): DetectedCred[] {
  const out: DetectedCred[] = [];
  for (const p of CATALOG) {
    if (p.authKind !== "api-key" && p.authKind !== "openai-compat") continue;
    for (const ev of p.envVars) {
      const v = process.env[ev];
      if (v) {
        out.push({ provider: p.id, label: p.label, envVar: ev, value: v });
        break;
      }
    }
  }
  return out;
}

/** Import a detected env key as a stored account (id `<provider>-env`, idempotent). */
export async function importEnvCred(c: DetectedCred): Promise<Account> {
  const id = `${c.provider}-env`;
  const ref = `${id}:api-key`;
  await setSecret(ref, c.value);
  const cat = CATALOG.find((p) => p.id === c.provider)!;
  const account: Account = {
    id,
    label: `${c.label} (from ${c.envVar})`,
    provider: c.provider,
    exec: "in-loop",
    auth: cat.authKind === "openai-compat" ? { kind: "openai-compat", ref } : { kind: "api-key", ref },
    baseUrl: cat.baseUrl,
    enabled: true,
    addedAt: Date.now(),
  };
  putAccount(account);
  return account;
}

/** Detected env creds not yet stored as an account — the import candidates. */
export function importableEnvCreds(): DetectedCred[] {
  return detectEnvCreds().filter((c) => !getAccount(`${c.provider}-env`));
}

// ── cloud detection (P2): AWS / Azure / Vertex from env + ~/.aws/credentials ──
export interface DetectedCloud {
  provider: "bedrock" | "azure" | "vertex";
  label: string;
  source: string;
  // resolved fields (secrets get moved into the store on import)
  aws?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string; region: string };
  azure?: { resourceName: string; apiKey: string };
  vertex?: { project: string; location: string };
}

// Minimal INI reader for ~/.aws/credentials / ~/.aws/config (default profile).
function awsIni(file: string, profile = "default"): Record<string, string> {
  if (!existsSync(file)) return {};
  const out: Record<string, string> = {};
  let cur = "";
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (line.startsWith("[")) cur = line.slice(1, -1).replace(/^profile\s+/, "");
    else if (cur === profile && line.includes("=")) {
      const i = line.indexOf("=");
      out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    }
  }
  return out;
}

export function detectCloudCreds(): DetectedCloud[] {
  const out: DetectedCloud[] = [];
  // AWS: env first, then ~/.aws/credentials (respects AWS_PROFILE).
  const awsProfile = process.env.AWS_PROFILE ?? "default";
  const home = homedir();
  const creds = awsIni(join(home, ".aws", "credentials"), awsProfile);
  const conf = awsIni(join(home, ".aws", "config"), awsProfile);
  const akid = process.env.AWS_ACCESS_KEY_ID ?? creds.aws_access_key_id;
  const secret = process.env.AWS_SECRET_ACCESS_KEY ?? creds.aws_secret_access_key;
  const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? conf.region;
  if (akid && secret) {
    out.push({
      provider: "bedrock",
      label: "Amazon Bedrock",
      source: process.env.AWS_ACCESS_KEY_ID ? "env" : "~/.aws/credentials",
      aws: { accessKeyId: akid, secretAccessKey: secret, sessionToken: process.env.AWS_SESSION_TOKEN ?? creds.aws_session_token, region: region ?? "us-east-1" },
    });
  }
  // Azure
  if (process.env.AZURE_API_KEY && process.env.AZURE_RESOURCE_NAME) {
    out.push({ provider: "azure", label: "Azure OpenAI", source: "env", azure: { resourceName: process.env.AZURE_RESOURCE_NAME, apiKey: process.env.AZURE_API_KEY } });
  }
  // Vertex (project + ADC/GOOGLE_APPLICATION_CREDENTIALS)
  if (process.env.GOOGLE_VERTEX_PROJECT) {
    out.push({ provider: "vertex", label: "Google Vertex AI", source: "env", vertex: { project: process.env.GOOGLE_VERTEX_PROJECT, location: process.env.GOOGLE_VERTEX_LOCATION ?? "us-central1" } });
  }
  return out;
}

export async function importCloudCred(c: DetectedCloud): Promise<Account> {
  const id = `${c.provider}-import`;
  let auth: Account["auth"];
  if (c.aws) {
    await setSecret(`${id}:akid`, c.aws.accessKeyId);
    await setSecret(`${id}:secret`, c.aws.secretAccessKey);
    if (c.aws.sessionToken) await setSecret(`${id}:token`, c.aws.sessionToken);
    auth = { kind: "aws", accessKeyIdRef: `${id}:akid`, secretKeyRef: `${id}:secret`, sessionTokenRef: c.aws.sessionToken ? `${id}:token` : undefined, region: c.aws.region };
  } else if (c.azure) {
    await setSecret(`${id}:api-key`, c.azure.apiKey);
    auth = { kind: "azure", resourceName: c.azure.resourceName, ref: `${id}:api-key` };
  } else {
    auth = { kind: "vertex", project: c.vertex!.project, location: c.vertex!.location, adc: true };
  }
  const account: Account = { id, label: `${c.label} (from ${c.source})`, provider: c.provider, exec: "in-loop", auth, enabled: true, addedAt: Date.now() };
  putAccount(account);
  return account;
}

export function importableCloudCreds(): DetectedCloud[] {
  return detectCloudCreds().filter((c) => !getAccount(`${c.provider}-import`));
}
