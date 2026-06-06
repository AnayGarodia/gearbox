// Turn an Account into something runnable. In-loop accounts produce ResolvedCreds
// (secrets fetched from the store) that providers.resolveModel injects into the
// AI SDK — keeping providers.ts the single SDK seam (it never touches the store).
// CLI accounts have no in-loop creds; the App routes them to the cli backend.
import { getSecret, defaultAccount, listAccounts } from "./store.ts";
import { catalogProvider } from "./catalog.ts";
import type { Account, ResolvedCreds, HealthState } from "./types.ts";
import { candidateModelsFor } from "../model/family.ts";
import type { ModelSpec } from "../providers.ts";

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
  if (auth.kind === "aws") {
    return {
      aws: {
        accessKeyId: (await getSecret(auth.accessKeyIdRef)) ?? "",
        secretAccessKey: (await getSecret(auth.secretKeyRef)) ?? "",
        sessionToken: auth.sessionTokenRef ? (await getSecret(auth.sessionTokenRef)) ?? undefined : undefined,
        region: auth.region,
      },
    };
  }
  if (auth.kind === "azure") {
    return { azure: { resourceName: auth.resourceName, apiKey: (await getSecret(auth.ref)) ?? "", apiVersion: auth.apiVersion } };
  }
  if (auth.kind === "vertex") {
    const sa = auth.serviceAccountRef ? await getSecret(auth.serviceAccountRef) : null;
    let credentials: Record<string, unknown> | undefined;
    try {
      credentials = sa ? JSON.parse(sa) : undefined;
    } catch {
      credentials = undefined; // malformed SA json → fall back to ADC
    }
    return { vertex: { project: auth.project, location: auth.location, credentials } };
  }
  // cli accounts run via the subprocess backend (no in-loop creds).
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

export interface Candidate {
  account: Account;
  model: ModelSpec; // the provider-specific spec to run on this account
}

// Lower = better. Healthy first, unknown next, unhealthy last.
function healthRank(s: HealthState | undefined): number {
  if (s === "ok") return 0;
  if (s === undefined || s === "unknown" || s === "real-error") return 1;
  if (s === "rate-limited") return 2; // transient; better than a dead key
  return 3; // expired / invalid / no-credit
}

/** Pure: given a target model and a set of accounts, return failover candidates
 *  best-first. Each candidate binds the account to the provider-specific spec. */
export function rankCandidates(model: ModelSpec, accounts: Account[]): Candidate[] {
  const family = candidateModelsFor(model); // all specs in the family
  const byProvider = new Map<string, ModelSpec>();
  for (const m of family) if (!byProvider.has(m.provider)) byProvider.set(m.provider, m);
  // Prefer the exact requested spec for its own provider.
  byProvider.set(model.provider, model);

  const cands: Candidate[] = [];
  for (const a of accounts) {
    if (!a.enabled) continue;
    const spec = byProvider.get(a.provider);
    if (!spec) continue; // this account's provider can't serve the family
    cands.push({ account: a, model: spec });
  }
  // Stable sort by health; preserve input order within a tier (user order).
  return cands.map((c, i) => ({ c, i }))
    .sort((x, y) => healthRank(x.c.account.health?.state) - healthRank(y.c.account.health?.state) || x.i - y.i)
    .map(({ c }) => c);
}

/** Live ranking from the registry. */
export function rank(model: ModelSpec): Candidate[] {
  return rankCandidates(model, listAccounts());
}
