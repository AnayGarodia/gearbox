/**
 * Application-level configuration for Gearbox.
 *
 * Kept intentionally small in v0.1. The routing layer (tiers, per-request
 * budgets, quality bars, cost caps) will extend this when it ships; those
 * fields will live alongside the ones below.
 *
 * Every field has an environment-variable override so CI pipelines, Docker
 * images, and power users can tune behaviour without touching code.
 *
 * The `defaultModelId` field is the routing seam: all call sites that need
 * a model but did not receive one from the user resolve through
 * `pickDefaultModel`, which uses this id as its preferred candidate. When
 * the router arrives it will slot in here, not scattered through the UI,
 * so the rest of the app stays model-agnostic.
 */
import { providerAvailable, findModel, modelRegistry, type ModelSpec } from "./providers.ts";
import { listAccounts } from "./accounts/store.ts";

export interface Config {
  /**
   * Model id to use when the user has not explicitly selected one.
   *
   * Override: GEARBOX_MODEL (any id from the MODELS registry, e.g.
   * "gpt-5.5" or "gemini-3.5-flash"). The default ships as
   * "claude-sonnet-4-6" but falls back automatically to the first
   * available model when its provider has no credentials (see
   * pickDefaultModel). This field is the single seam the router
   * will replace: instead of a static default it will return a
   * scored candidate at call time.
   */
  defaultModelId: string;

  /**
   * Maximum number of agentic loop steps before the run is halted.
   *
   * Override: GEARBOX_MAX_STEPS (integer). Prevents runaway tool-call
   * loops from consuming unbounded tokens. The AI SDK's `maxSteps`
   * option receives this value directly.
   */
  maxSteps: number;
}

export const config: Config = {
  defaultModelId: process.env.GEARBOX_MODEL ?? "claude-sonnet-4-6",
  maxSteps: Number(process.env.GEARBOX_MAX_STEPS ?? 24),
};

/**
 * Resolves the model that should run when no explicit model is given.
 *
 * Resolution order:
 *   1. The preferred id (preferredId argument, or config.defaultModelId).
 *   2. The first model in the registry whose provider has a usable key.
 *   3. undefined, signalling that no provider is configured.
 *
 * Returning undefined rather than a model with no credentials lets callers
 * surface a clear "no provider configured" error instead of a cryptic
 * network failure mid-run.
 *
 * This function is the routing seam: the future router will replace step 2
 * with a scored selection rather than "first available".
 */
export function pickDefaultModel(preferredId?: string): ModelSpec | undefined {
  const pref = preferredId ?? config.defaultModelId;
  const wanted = findModel(pref);
  if (wanted && providerAvailable(wanted.provider)) return wanted;
  return modelRegistry().find((m) => providerAvailable(m.provider));
}

/**
 * Looks up a ModelSpec by exact id, with a module-level cache.
 *
 * The cache is populated on first access per id and retained for the
 * lifetime of the process. Call clearModelCache() to invalidate it,
 * for example after the account store changes in tests.
 */
const _modelCache = new Map<string, ModelSpec | undefined>();
export function getModelById(id: string): ModelSpec | undefined {
  if (_modelCache.has(id)) return _modelCache.get(id);
  const all = modelRegistry();
  const found = all.find((m) => m.id === id);
  _modelCache.set(id, found);
  return found;
}

/** Clears the model lookup cache (useful after registry changes in tests). */
export function clearModelCache(): void { _modelCache.clear(); }

/**
 * Returns true when at least one provider is ready to accept calls.
 *
 * "Ready" means either:
 *   - A model in the registry has its provider's credentials available, OR
 *   - A CLI subscription account is enabled (claude, codex, etc.).
 *
 * The CLI subscription check is necessary because subscription accounts
 * do not appear in the model registry (they run via a vendor binary, not
 * the API seam), yet they are a valid execution path. Without it, a
 * subscription-only install would pass onboarding but be blocked at the
 * launch gate in cli.tsx.
 */
export function anyProviderAvailable(): boolean {
  if (modelRegistry().some((m) => providerAvailable(m.provider))) return true;
  // A CLI subscription (claude/codex) is a usable provider even though it never
  // appears in the model registry — it runs via the vendor binary, not the API
  // seam. Without this, a subscription-only setup is "ready" in onboarding but the
  // launch gate (cli.tsx) exits, so the app shows the splash and never opens.
  return listAccounts().some((a) => a.enabled && a.exec === "cli");
}
