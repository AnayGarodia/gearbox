// src/agent/failover.ts
// Wraps a single model turn in an ordered account pool. On a credential-class
// failure that happened BEFORE any output, advance to the next candidate; on a
// real error (or once output streamed), stop. Records health for each attempt
// and surfaces a clear, actionable error if the whole pool is exhausted.
import { classifyError, isCredentialFailure, type HealthState } from "../accounts/health.ts";
import type { Candidate } from "../accounts/resolve.ts";
import type { Account, ResolvedCreds } from "../accounts/types.ts";
import type { OnEvent, Usage } from "./events.ts";
import type { ModelMessage } from "ai";

export interface RunOneResult {
  messages: ModelMessage[];
  usage: Usage;
  failure?: { message: string; raw: unknown; producedOutput: boolean };
}

export interface FailoverOpts {
  candidates: Candidate[];
  onEvent: OnEvent;
  recordHealth: (account: Account, state: HealthState, detail?: string) => void;
  resolveCreds: (account: Account) => Promise<ResolvedCreds>;
  runOne: (args: { account: Account; model: Candidate["model"]; creds: ResolvedCreds }) => Promise<RunOneResult>;
}

export interface FailoverResult extends RunOneResult {
  usedAccountId?: string;
}

// A friendly one-line fix per failure state — shown when the pool is exhausted.
export function fixHint(account: Account, state: HealthState): string {
  if (state === "no-credit") return `add credit, or switch: /account <name>`;
  if (account.exec === "cli" && (state === "expired" || state === "invalid"))
    return `re-login: /account login ${account.slug ?? account.id}`;
  if (state === "invalid" || state === "expired") return `replace the key: /account add ${account.provider} <key>`;
  if (state === "rate-limited") return `wait, or switch: /account <name>`;
  return `check: /account ${account.slug ?? account.id}`;
}

export async function runWithFailover(opts: FailoverOpts): Promise<FailoverResult> {
  const { candidates, onEvent, recordHealth, resolveCreds, runOne } = opts;
  const tried: { account: Account; state: HealthState; message: string }[] = [];

  if (!candidates.length) {
    onEvent({ type: "error", message: "no account is configured for this model — run /account add to add one" });
    return { messages: [], usage: { inputTokens: 0, outputTokens: 0 } };
  }

  for (let i = 0; i < candidates.length; i++) {
    const { account, model } = candidates[i]!;
    const creds = await resolveCreds(account);
    const res = await runOne({ account, model, creds });

    if (!res.failure) {
      recordHealth(account, "ok");
      return { ...res, usedAccountId: account.id };
    }

    const state = classifyError(account.provider, res.failure.raw);
    recordHealth(account, state, res.failure.message);
    tried.push({ account, state, message: res.failure.message });

    const canFailover = isCredentialFailure(state) && !res.failure.producedOutput && i < candidates.length - 1;
    if (canFailover) {
      const next = candidates[i + 1]!.account;
      onEvent({ type: "phase", label: `${account.slug ?? account.id} ${state}`, detail: `→ using ${next.slug ?? next.id}`, state: "err" });
      continue;
    }

    // Terminal: emit one consolidated, actionable error now.
    onEvent({ type: "error", message: failureReport(tried) });
    return { ...res };
  }

  onEvent({ type: "error", message: failureReport(tried) });
  return { messages: [], usage: { inputTokens: 0, outputTokens: 0 } };
}

function failureReport(tried: { account: Account; state: HealthState; message: string }[]): string {
  if (tried.length === 1) {
    const t = tried[0]!;
    return `${t.account.slug ?? t.account.id} failed (${t.state}): ${t.message}\n  ${fixHint(t.account, t.state)}`;
  }
  const lines = tried.map((t) => `  • ${t.account.slug ?? t.account.id} — ${t.state}: ${t.message}\n      ${fixHint(t.account, t.state)}`);
  return [`all ${tried.length} accounts for this model failed:`, ...lines].join("\n");
}
