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

// provider id → how to read its balance. Each parser gets the JSON body.
const PROVIDERS: Record<string, { url: string; parse: (j: any) => Balance | null }> = {
  // GET /credits → { data: { total_credits, total_usage } }
  openrouter: {
    url: "https://openrouter.ai/api/v1/credits",
    parse: (j) => {
      const d = j?.data;
      if (!d || typeof d.total_credits !== "number") return null;
      return { remainingUSD: d.total_credits - (d.total_usage ?? 0), totalUSD: d.total_credits };
    },
  },
  // Vercel AI Gateway → { balance } or { credits: { balance } } (best-effort).
  "vercel-gateway": {
    url: "https://ai-gateway.vercel.sh/v1/credits",
    parse: (j) => {
      const bal = j?.balance ?? j?.credits?.balance;
      return typeof bal === "number" ? { remainingUSD: bal } : null;
    },
  },
};

/** True if we have a balance reader for this provider. */
export function balanceExposed(provider: string): boolean {
  return provider in PROVIDERS;
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
