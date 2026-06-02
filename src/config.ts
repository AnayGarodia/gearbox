// Minimal config for v0.1. Kept tiny on purpose; the routing config (tiers,
// prices, budgets, bars) arrives with the router and will live alongside this.
import { MODELS, providerAvailable, findModel, type ModelSpec } from "./providers.ts";

export interface Config {
  defaultModelId: string;
  maxSteps: number;
}

export const config: Config = {
  defaultModelId: process.env.GEARBOX_MODEL ?? "claude-sonnet-4-6",
  maxSteps: Number(process.env.GEARBOX_MAX_STEPS ?? 24),
};

/** Pick the preferred model if its provider has a key, else the first available.
 *  Returns undefined when NO provider has a key (the selector then errors rather
 *  than handing back a model it can't actually run). */
export function pickDefaultModel(preferredId?: string): ModelSpec | undefined {
  const pref = preferredId ?? config.defaultModelId;
  const wanted = findModel(pref);
  if (wanted && providerAvailable(wanted.provider)) return wanted;
  return MODELS.find((m) => providerAvailable(m.provider));
}

export function anyProviderAvailable(): boolean {
  return MODELS.some((m) => providerAvailable(m.provider));
}
