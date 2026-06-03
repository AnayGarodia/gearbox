// Turn an Account into something runnable. In-loop accounts produce ResolvedCreds
// (secrets fetched from the store) that providers.resolveModel injects into the
// AI SDK — keeping providers.ts the single SDK seam (it never touches the store).
// CLI accounts have no in-loop creds; the App routes them to the cli backend.
import { getSecret, defaultAccount } from "./store.ts";
import { catalogProvider } from "./catalog.ts";
import type { Account, ResolvedCreds } from "./types.ts";

/** Fetch + assemble the credentials an in-loop account needs to run a model. */
export async function resolveCreds(account: Account): Promise<ResolvedCreds> {
  const auth = account.auth;
  if (auth.kind === "api-key") {
    return { apiKey: (await getSecret(auth.ref)) ?? undefined };
  }
  if (auth.kind === "openai-compat") {
    const cat = catalogProvider(account.provider);
    return {
      apiKey: (await getSecret(auth.ref)) ?? undefined,
      baseURL: account.baseUrl ?? cat?.baseUrl,
      headers: account.extraHeaders,
    };
  }
  // aws / azure / vertex are wired in P2; cli accounts run via the subprocess
  // backend (no in-loop creds).
  return {};
}

// Picks WHICH account runs a given provider (separate from the ModelSelector,
// which picks the model). v1: the provider's default account (explicit, else the
// first enabled). Failover / round-robin / credit-awareness come later.
export class AccountResolver {
  pick(provider: string): Account | undefined {
    return defaultAccount(provider);
  }
}
