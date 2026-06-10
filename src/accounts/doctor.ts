// `gearbox doctor live` — the provider truth matrix. One tiny REAL call per
// enabled account (a few tokens; costs fractions of a cent total) so "which of
// my providers actually work right now" is one command instead of an evening
// of debugging. Every failure is classified and paired with the ONE command
// that fixes it — the row tells you what to do, not just what broke.
import { generateText } from "ai";
import { resolveModel, modelRegistry, type ModelSpec } from "../providers.ts";
import { resolveCreds } from "./resolve.ts";
import { classifyError, type HealthState } from "./health.ts";
import { fixHint } from "../agent/failover.ts";
import { listAccounts } from "./store.ts";
import { importableEnvCreds } from "./detect.ts";
import { which } from "../proc.ts";
import type { Account } from "./types.ts";

export interface DoctorRow {
  account: string; // slug or "env:<provider>"
  provider: string;
  model: string; // what was actually called
  ok: boolean;
  ms?: number;
  state?: HealthState | "ready" | "skipped";
  message?: string; // one line, human
  fix?: string; // the command that fixes it
}

const LIVE_TIMEOUT_MS = 15_000;

function timeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timed out after ${ms / 1000}s — endpoint unreachable or hanging`)), ms)),
  ]);
}

/** Pick the model to live-test for an account: a registry model this provider
 *  serves, preferring the account's own discovered list (those ids are the
 *  ones discovery PROVED callable). Falls back to a minimal synthesized spec
 *  for discovered-only ids (gateways, Azure deployments). */
export function pickTestModel(account: Account): ModelSpec | null {
  const registry = modelRegistry().filter((m) => m.provider === account.provider);
  if (account.models?.length) {
    const known = registry.find((m) => account.models!.includes(m.sdkId));
    if (known) return known;
    const sdkId = account.models[0]!;
    return { id: `${account.provider}/${sdkId}`, provider: account.provider, sdkId, label: sdkId, contextWindow: 128_000 };
  }
  // Prefer the cheapest registry model (haiku-class) — this is a health probe,
  // not a quality test.
  const sorted = [...registry].sort((a, b) => (a.cost?.inUSDPerMtok ?? 1e6) - (b.cost?.inUSDPerMtok ?? 1e6));
  return sorted[0] ?? null;
}

function oneLine(e: unknown): string {
  const m = (e as any)?.message ?? String(e);
  return String(m).replace(/\s+/g, " ").slice(0, 140);
}

export async function liveCheckAccount(account: Account): Promise<DoctorRow> {
  const name = account.slug ?? account.id;
  if (account.exec === "cli") {
    const binary = account.auth.kind === "cli" ? account.auth.binary : "claude";
    const found = which(binary);
    return found
      ? { account: name, provider: account.provider, model: binary, ok: true, state: "ready", message: "binary present · not live-called (subscription turns aren't free probes)" }
      : { account: name, provider: account.provider, model: binary, ok: false, state: "invalid", message: `the ${binary} binary isn't on PATH`, fix: `install ${binary}, then /account login ${name}` };
  }
  const spec = pickTestModel(account);
  if (!spec) {
    return { account: name, provider: account.provider, model: "—", ok: false, state: "skipped", message: "no model known for this provider", fix: `/account refresh` };
  }
  const startedAt = Date.now();
  try {
    const creds = await resolveCreds(account);
    const model = resolveModel(spec, creds);
    await timeout(generateText({ model, prompt: "Reply with exactly: ok", maxOutputTokens: 8, maxRetries: 0 }), LIVE_TIMEOUT_MS);
    return { account: name, provider: account.provider, model: spec.label, ok: true, ms: Date.now() - startedAt };
  } catch (e) {
    const state = classifyError(account.provider, e);
    return {
      account: name, provider: account.provider, model: spec.label, ok: false, state,
      message: oneLine(e),
      fix: fixHint(account, state),
    };
  }
}

/** Live-check every enabled account, plus bare env keys with no stored account.
 *  Sequential on purpose: parallel-probing 10 providers looks like abuse and
 *  muddles which row a network hiccup belongs to. onRow streams progress. */
export async function liveCheckAll(onRow?: (row: DoctorRow) => void): Promise<DoctorRow[]> {
  const rows: DoctorRow[] = [];
  const accounts = listAccounts().filter((a) => a.enabled);
  const covered = new Set(accounts.map((a) => a.provider));
  for (const a of accounts) {
    const row = await liveCheckAccount(a);
    rows.push(row);
    onRow?.(row);
  }
  // Env-only providers (key in the environment, no stored account).
  for (const c of importableEnvCreds()) {
    if (covered.has(c.provider)) continue;
    covered.add(c.provider);
    const fake: Account = { id: `env:${c.provider}`, label: `${c.provider} (env)`, provider: c.provider, exec: "in-loop", auth: { kind: "api-key", ref: "" }, enabled: true, addedAt: 0 } as Account;
    const spec = pickTestModel(fake);
    if (!spec) continue;
    const startedAt = Date.now();
    try {
      const model = resolveModel(spec, undefined); // env-default path
      await timeout(generateText({ model, prompt: "Reply with exactly: ok", maxOutputTokens: 8, maxRetries: 0 }), LIVE_TIMEOUT_MS);
      const row: DoctorRow = { account: `env:${c.provider}`, provider: c.provider, model: spec.label, ok: true, ms: Date.now() - startedAt };
      rows.push(row); onRow?.(row);
    } catch (e) {
      const state = classifyError(c.provider, e);
      const row: DoctorRow = {
        account: `env:${c.provider}`, provider: c.provider, model: spec.label, ok: false, state,
        message: oneLine(e),
        fix: state === "invalid" || state === "expired" ? `replace ${c.envVar}, or /account add ${c.provider} <key>` : `check ${c.envVar}`,
      };
      rows.push(row); onRow?.(row);
    }
  }
  return rows;
}

/** Render the matrix for the terminal (plain text; the CLI adds color). */
export function formatDoctorRows(rows: DoctorRow[]): string {
  if (!rows.length) return "no accounts to check · gearbox auth add <key>";
  const aw = Math.max(7, ...rows.map((r) => r.account.length));
  const mw = Math.max(5, ...rows.map((r) => r.model.length));
  const lines = rows.map((r) => {
    const head = `${r.account.padEnd(aw)}  ${r.model.padEnd(mw)}  `;
    if (r.ok) return head + `✓ ok${r.ms != null ? ` · ${r.ms}ms` : ""}${r.state === "ready" ? ` · ${r.message}` : ""}`;
    return head + `✗ ${r.state ?? "error"} · ${r.message ?? ""}${r.fix ? `\n${" ".repeat(aw + 2)}fix: ${r.fix}` : ""}`;
  });
  const okCount = rows.filter((r) => r.ok).length;
  return lines.join("\n") + `\n\n${okCount}/${rows.length} working`;
}
