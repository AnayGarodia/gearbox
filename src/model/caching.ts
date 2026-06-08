// Prompt caching: mark the stable prefix (tools + system + settled history) so a
// provider with explicit cache breakpoints reuses it across turns at a fraction
// of the input price (Anthropic cache reads bill ≈10%). Pure + provider-aware;
// the runner calls this right before streamText.
//
// Providers that cache AUTOMATICALLY need NO markers and pass through untouched —
// we just read the cache-read tokens back from usage to show the benefit:
//   • OpenAI / Azure OpenAI — prompt caching kicks in automatically over ~1024 tok
//   • DeepSeek — context caching on disk, automatic
//   • Google Gemini — implicit caching for 2.5+ models, automatic
//
// Providers that need an EXPLICIT breakpoint (handled here):
//   • anthropic — `cacheControl: {type:"ephemeral"}` on the system + last message
//   • bedrock (Claude / Amazon Nova) — a `cachePoint` block after the content
//
// The Anthropic cache hierarchy is tools → system → messages, and a breakpoint
// caches everything BEFORE it. So one marker on the system block already covers
// tools + system; a second on the last message extends the cached prefix to the
// whole conversation so far. Each turn the prior turn's write becomes the next
// turn's read, so the cached prefix grows for free.
import type { ModelMessage } from "ai";
import type { ModelSpec } from "../providers.ts";

export type CacheKind = "anthropic" | "bedrock" | null;

// Which explicit-breakpoint scheme (if any) this model's provider needs.
export function cacheKind(spec: ModelSpec): CacheKind {
  if (spec.provider === "anthropic") return "anthropic";
  // Claude + Amazon Nova on Bedrock support cache points; other Bedrock families
  // (Llama, etc.) may not, so only opt those two in to avoid an API error.
  if (spec.provider === "bedrock" && /claude|anthropic|nova/i.test(spec.sdkId)) return "bedrock";
  return null;
}

// The provider-options marker that rides on a cached message (read by the AI SDK
// provider's message converter — message-level options apply to the last part).
function marker(kind: Exclude<CacheKind, null>): Record<string, Record<string, unknown>> {
  return kind === "anthropic"
    ? { anthropic: { cacheControl: { type: "ephemeral" } } }
    : { bedrock: { cachePoint: { type: "default" } } };
}

/**
 * Return `{system, messages}` with cache breakpoints applied for the model's
 * provider. For explicit-breakpoint providers we move the system prompt into a
 * leading system MESSAGE (the `system` string param can't carry providerOptions,
 * so a marker can't ride on it otherwise) and mark the last message, so the
 * cached prefix grows each turn. For every other provider the inputs pass through
 * unchanged — they cache automatically. The wire format is identical either way:
 * the provider maps the first system message back to the top-level system field.
 */
export function withPromptCaching(
  spec: ModelSpec,
  system: string | undefined,
  messages: ModelMessage[],
  // Which message ends the cacheable prefix. Default = the last message (cache the
  // whole conversation). The context engine passes the index of the last SETTLED
  // history message so the per-turn VOLATILE tail (freshly retrieved files + git
  // state, which change every turn) rides AFTER the breakpoint and doesn't bust the
  // cached prefix. Out of range (e.g. -1 on the first turn) → only the system block
  // is marked.
  cacheBreakIndex?: number,
): { system: string | undefined; messages: ModelMessage[] } {
  const kind = cacheKind(spec);
  if (!kind) return { system, messages };
  const mark = marker(kind);

  const out: ModelMessage[] = [];
  if (system && system.trim()) {
    out.push({ role: "system", content: system, providerOptions: mark } as ModelMessage);
  }
  const n = messages.length;
  const breakAt = cacheBreakIndex === undefined ? n - 1 : cacheBreakIndex;
  for (let i = 0; i < n; i++) {
    const m = messages[i]!;
    // Mark the breakpoint message → everything up to it becomes one cached prefix.
    // Deep-merge into any existing providerOptions so a pre-existing provider option
    // is kept, not clobbered (the marker has exactly one provider key).
    if (i === breakAt) {
      const prev = ((m as { providerOptions?: Record<string, Record<string, unknown>> }).providerOptions ?? {});
      const merged: Record<string, Record<string, unknown>> = { ...prev };
      for (const [provider, opts] of Object.entries(mark)) {
        merged[provider] = { ...(prev[provider] ?? {}), ...opts };
      }
      out.push({ ...(m as object), providerOptions: merged } as ModelMessage);
    } else {
      out.push(m);
    }
  }
  return { system: undefined, messages: out };
}
