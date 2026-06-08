import { test, expect } from "bun:test";
import type { ModelMessage } from "ai";
import { cacheKind, withPromptCaching } from "../src/model/caching.ts";
import type { ModelSpec } from "../src/providers.ts";

const spec = (provider: string, sdkId: string): ModelSpec => ({
  id: `${provider}/${sdkId}`,
  provider,
  sdkId,
  label: sdkId,
  contextWindow: 200_000,
});

const anthropicMark = (m: any) => m?.providerOptions?.anthropic?.cacheControl?.type;
const bedrockMark = (m: any) => m?.providerOptions?.bedrock?.cachePoint?.type;

const convo: ModelMessage[] = [
  { role: "user", content: "first question" },
  { role: "assistant", content: "first answer" },
  { role: "user", content: "second question" },
];

test("cacheKind: explicit breakpoints for anthropic + bedrock claude/nova, none elsewhere", () => {
  expect(cacheKind(spec("anthropic", "claude-sonnet-4-6"))).toBe("anthropic");
  expect(cacheKind(spec("bedrock", "anthropic.claude-sonnet-4-20250514-v1:0"))).toBe("bedrock");
  expect(cacheKind(spec("bedrock", "amazon.nova-pro-v1:0"))).toBe("bedrock");
  // Bedrock Llama doesn't support cache points → no marker (avoids an API error).
  expect(cacheKind(spec("bedrock", "meta.llama4-scout-17b-instruct-v1:0"))).toBeNull();
  expect(cacheKind(spec("openai", "gpt-5.5"))).toBeNull();
  expect(cacheKind(spec("deepseek", "deepseek-v4-pro"))).toBeNull();
  expect(cacheKind(spec("google", "gemini-3.5-flash"))).toBeNull();
});

test("anthropic: system becomes a leading marked system message + last message marked", () => {
  const { system, messages } = withPromptCaching(spec("anthropic", "claude-sonnet-4-6"), "SYS PROMPT", convo);
  // The top-level system string is dropped (it now rides as a message that can carry the marker).
  expect(system).toBeUndefined();
  expect(messages[0]!.role).toBe("system");
  expect((messages[0] as any).content).toBe("SYS PROMPT");
  expect(anthropicMark(messages[0])).toBe("ephemeral"); // tools+system cached
  // Last message marked → the whole conversation so far is one cache breakpoint.
  expect(anthropicMark(messages[messages.length - 1])).toBe("ephemeral");
  // Middle messages stay clean (only 2 breakpoints, well under Anthropic's max of 4).
  expect(anthropicMark(messages[2])).toBeUndefined();
  // No content was lost or reordered.
  expect(messages.filter((m) => m.role !== "system").map((m) => (m as any).content)).toEqual(
    convo.map((m) => m.content),
  );
});

test("bedrock claude: same shape but with a cachePoint marker", () => {
  const { system, messages } = withPromptCaching(spec("bedrock", "anthropic.claude-sonnet-4-20250514-v1:0"), "SYS", convo);
  expect(system).toBeUndefined();
  expect(messages[0]!.role).toBe("system");
  expect(bedrockMark(messages[0])).toBe("default");
  expect(bedrockMark(messages[messages.length - 1])).toBe("default");
});

test("auto-cache providers pass through untouched (no markers, system stays a string)", () => {
  for (const m of [spec("openai", "gpt-5.5"), spec("deepseek", "deepseek-v4-pro"), spec("google", "gemini-3.5-flash")]) {
    const out = withPromptCaching(m, "SYS", convo);
    expect(out.system).toBe("SYS");
    expect(out.messages).toBe(convo); // identity — not rebuilt
  }
});

test("anthropic edge cases: empty system, empty messages", () => {
  // No system → no system message, but the last message is still a breakpoint.
  const noSys = withPromptCaching(spec("anthropic", "claude-sonnet-4-6"), "", convo);
  expect(noSys.messages[0]!.role).toBe("user");
  expect(anthropicMark(noSys.messages[noSys.messages.length - 1])).toBe("ephemeral");
  // No messages → just the marked system message.
  const noMsgs = withPromptCaching(spec("anthropic", "claude-sonnet-4-6"), "SYS", []);
  expect(noMsgs.messages).toHaveLength(1);
  expect(noMsgs.messages[0]!.role).toBe("system");
  expect(anthropicMark(noMsgs.messages[0])).toBe("ephemeral");
});

test("an explicit cacheBreakIndex marks that message, leaving the volatile tail uncached", () => {
  // [settled user, settled assistant, volatile user turn]; break at the settled end (1).
  const msgs: ModelMessage[] = [
    { role: "user", content: "q1" },
    { role: "assistant", content: "a1" },
    { role: "user", content: "turn-context + q2" },
  ];
  const { messages } = withPromptCaching(spec("anthropic", "claude-sonnet-4-6"), "SYS", msgs, 1);
  const settled = messages.find((m) => m.role === "assistant");
  expect(anthropicMark(settled)).toBe("ephemeral"); // settled-history end cached
  expect(anthropicMark(messages[messages.length - 1])).toBeUndefined(); // volatile tail NOT cached
});

test("cacheBreakIndex of -1 marks only the system block (first turn, no settled history)", () => {
  const { messages } = withPromptCaching(spec("anthropic", "claude-sonnet-4-6"), "SYS", [{ role: "user", content: "first" }], -1);
  expect(messages[0]!.role).toBe("system");
  expect(anthropicMark(messages[0])).toBe("ephemeral");
  expect(anthropicMark(messages[messages.length - 1])).toBeUndefined(); // the lone user turn is the volatile tail
});

test("an existing providerOptions on the last message is preserved (merged, not clobbered)", () => {
  const msgs: ModelMessage[] = [
    { role: "user", content: "q", providerOptions: { anthropic: { foo: "bar" } } } as any,
  ];
  const { messages } = withPromptCaching(spec("anthropic", "claude-sonnet-4-6"), "SYS", msgs);
  const last = messages[messages.length - 1] as any;
  expect(last.providerOptions.anthropic.cacheControl.type).toBe("ephemeral");
  expect(last.providerOptions.anthropic.foo).toBe("bar"); // pre-existing option kept
});
