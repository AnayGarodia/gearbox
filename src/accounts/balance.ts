// Remaining-credit lookup for API-key accounts. MOST providers don't expose a
// balance on a normal key (Anthropic/OpenAI/Google/DeepSeek bill you and show
// the balance only in their dashboard), so this covers the few that do via a
// simple authenticated GET. Everything else returns null and the UI shows spend
// instead. Network-guarded + short-timeout so /usage never hangs.
import { getSecret } from "./store.ts";
import type { Account } from "./types.ts";

export interface Balance {
  remainingUSD?: number;
  totalUSD?: number;
}

// Provider id to balance-fetch config. Each parser receives the parsed JSON body.
const PROVIDERS: Record<string, { url: string; parse: (j: any) => Balance | null }> = {
  openrouter: {
    url: "https://openrouter.ai/api/v1/credits",
    parse: (j) => {
      const d = j?.data;
      if (!d || typeof d.total_credits !== "number") return null;
      return { remainingUSD: d.total_credits - (d.total_usage ?? 0), totalUSD: d.total_credits };
    },
  },
  // Vercel AI Gateway: response shape is { balance } or { credits: { balance } } (best-effort).
  "vercel-gateway": {
    url: "https://ai-gateway.vercel.sh/v1/credits",
    parse: (j) => {
      const bal = num(j?.balance ?? j?.credits?.balance); // field may be a numeric string, e.g. "95.50"
      return bal == null ? null : { remainingUSD: bal };
    },
  },
  // DeepSeek: { is_available, balance_infos: [{ currency, total_balance, … }] }.
  // Amounts are STRINGS; currency is "USD" or "CNY" — accounts topped up in RMB
  // (DeepSeek's primary billing currency) report ONLY a CNY row. Treating that
  // amount as dollars overstated the balance ~7x, so the scarcity term let a
  // nearly-broke key keep winning routing. A coarse CNY→USD estimate beats
  // both the 7x error and going blind (the project's standing rule).
  deepseek: {
    url: "https://api.deepseek.com/user/balance",
    parse: (j) => {
      const infos: any[] = Array.isArray(j?.balance_infos) ? j.balance_infos : [];
      const usd = num(infos.find((b) => b?.currency === "USD")?.total_balance);
      if (usd != null) return { remainingUSD: usd };
      const cny = num(infos.find((b) => b?.currency === "CNY")?.total_balance);
      if (cny != null) return { remainingUSD: Math.round((cny / 7.2) * 100) / 100 };
      return null;
    },
  },
};

// Coerce a provider's balance field (number or numeric string) to a number.
function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/** True if we have a balance reader for this provider. */
export function balanceExposed(provider: string): boolean {
  return provider in PROVIDERS;
}

/** Parse a provider's balance response body (pure; exposed for tests). Returns
 *  null when the provider is unknown or the shape doesn't carry a number. */
export function parseBalance(provider: string, body: unknown): Balance | null {
  return PROVIDERS[provider]?.parse(body) ?? null;
}

/** Fetch the remaining credit for an account, or null if unsupported / it fails.
 *  Never throws. */
export async function fetchBalance(account: Account, timeoutMs = 4000): Promise<Balance | null> {
  const p = PROVIDERS[account.provider];
  if (!p || account.auth.kind !== "api-key" && account.auth.kind !== "openai-compat") return null;
  const ref = (account.auth as any).ref as string | undefined;
  const key = ref ? await getSecret(ref) : undefined;
  if (!key) return null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(p.url, { headers: { Authorization: `Bearer ${key}` }, signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    return p.parse(await res.json());
  } catch {
    return null; // offline, timeout, shape change — fall back to spend
  }
}
