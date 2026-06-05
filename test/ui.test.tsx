import React from "react";
import { test, expect, beforeEach } from "bun:test";
import { render } from "ink-testing-library";
import { Transcript } from "../src/ui/components/Transcript.tsx";
import { CommandPalette } from "../src/ui/components/CommandPalette.tsx";
import { FilePalette } from "../src/ui/components/FilePalette.tsx";
import { itemsToLines } from "../src/ui/lines.ts";

// Pin the mascot to half-blocks so render assertions are deterministic regardless
// of which terminal runs the tests (kitty/Ghostty would emit image placeholders).
beforeEach(() => {
  process.env.GEARBOX_GHOST = "blocks";
});
import { Banner } from "../src/ui/components/Banner.tsx";
import { App } from "../src/ui/App.tsx";
import { FixedSelector } from "../src/model/selector.ts";
import type { Item } from "../src/ui/types.ts";

test("banner shows brand + model", () => {
  const { lastFrame } = render(<Banner model="sonnet-4.6" />);
  const f = lastFrame() ?? "";
  expect(f).toContain("gearbox");
  expect(f).toContain("sonnet-4.6");
});

test("transcript renders user, assistant, tools, error with the right glyphs", () => {
  const items: Item[] = [
    { kind: "user", id: 1, text: "fix the auth bug" },
    { kind: "assistant", id: 2, text: "On it.", done: true },
    { kind: "tool", id: 3, callId: "a", name: "read_file", arg: "auth.ts", status: "ok", summary: "42 lines" },
    { kind: "tool", id: 4, callId: "b", name: "run_shell", arg: "bun test", status: "err", summary: "2 failing" },
    { kind: "error", id: 5, text: "rate limited" },
  ];
  const { lastFrame } = render(<Transcript items={items} />);
  const f = lastFrame() ?? "";
  expect(f).toContain("fix the auth bug");
  expect(f).toContain("On it.");
  expect(f).toContain("read");
  expect(f).toContain("auth.ts");
  expect(f).toContain("42 lines");
  expect(f).toContain("shell");
  expect(f).toContain("rate limited");
  expect(f).toContain("▌"); // user prompt band
  expect(f).toContain("⏺"); // tool call marker
  expect(f).toContain("⎿"); // tool result connector
  expect(f).toContain("▲"); // error marker
});

test("transcript renders live phase, model, verification, and preference rows", () => {
  const items: Item[] = [
    { kind: "phase", id: 1, label: "building context", detail: "sonnet-4.6", state: "running" },
    { kind: "model", id: 2, model: "sonnet-4.6", provider: "anthropic", reason: "code · remembered preference" },
    { kind: "tool", id: 3, callId: "s", name: "run_shell", arg: "bun test", status: "running", summary: "", outputTail: "one\ntwo\n", outputLines: 2 },
    { kind: "verification", id: 4, command: "bun test", ok: false, summary: "failed" },
    { kind: "preference", id: 5, text: "Remember sonnet for code tasks?", acceptCommand: "/prefer code claude-sonnet-4-6" },
  ];
  const f = render(<Transcript items={items} width={120} />).lastFrame() ?? "";
  expect(f).toContain("building context");
  expect(f).toContain("using sonnet-4.6");
  expect(f).toContain("│ one");
  expect(f).toContain("check");
  expect(f).toContain("/prefer code claude-sonnet-4-6");
});

test("inline transcript commits the full history to scrollback (no clipped window)", () => {
  // Inline is the default; long sessions must show the EARLIEST item, not just a
  // visible window — finished items go to <Static>, the live tail re-renders.
  const items: Item[] = [];
  for (let i = 1; i <= 40; i++) {
    items.push({ kind: "user", id: i * 2, text: `MARKER-${i}` });
    items.push({ kind: "assistant", id: i * 2 + 1, text: `reply ${i}`, done: true });
  }
  items.push({ kind: "assistant", id: 999, text: "LIVE-TAIL", done: false });
  const { lastFrame } = render(<Transcript items={items} width={100} />);
  const f = lastFrame() ?? "";
  expect(f).toContain("MARKER-1"); // earliest is present (not clipped)
  expect(f).toContain("MARKER-40"); // latest committed is present
  expect(f).toContain("LIVE-TAIL"); // the streaming tail still renders
});

test("usage card groups by type: subscription limit bar + API-key spend (both paths)", () => {
  const view = {
    subscriptions: [
      {
        name: "Claude",
        turns: 4,
        tok: "17.7k/34",
        limits: [
          { pct: 42, label: "5-hour", resetsIn: "resets in 2h" },
          { pct: 87, label: "7-day" },
        ],
      },
    ],
    apiKeys: [
      { name: "OpenRouter", turns: 1, tok: "0/0", spend: "$0.00 spent", spendPos: false, balanceLeft: "$12.40 left", balanceFrac: 0.62 },
      { name: "Anthropic", turns: 3, tok: "0/0", spend: "$0.24 spent", spendPos: true, balanceNote: "balance not exposed" },
    ],
    labelPad: 10,
    spendPad: 11,
    totalApiSpend: "$0.24",
    sessionUSD: "$0.00",
    hasEstimate: true,
  };
  const item: Item = { kind: "usage", id: 1, view };
  // Inline path: both windows + balance/spend visible
  const inline = render(<Transcript items={[item]} width={120} />).lastFrame() ?? "";
  expect(inline).toContain("subscriptions");
  expect(inline).toContain("api keys");
  expect(inline).toContain("5-hour");
  expect(inline).toContain("7-day");
  expect(inline).toContain("42%");
  expect(inline).toContain("87%");
  expect(inline).toContain("resets in 2h");
  expect(inline).toContain("$12.40 left");
  expect(inline).toContain("balance not exposed");
  expect(inline).toContain("█");
  // Fullscreen path (itemsToLines → spans)
  const lines = itemsToLines([item], 120);
  const text = lines.map((l) => l.map((s) => s.text).join("")).join("\n");
  expect(text).toContain("5-hour");
  expect(text).toContain("7-day");
  expect(text).toContain("$12.40 left");
});

test("accounts card renders grouped rows with name aliases", () => {
  const item: Item = {
    kind: "accounts",
    id: 1,
    view: {
      current: "ChatGPT (maitree) · subscription",
      rows: [
        { name: "ChatGPT (maitree)", type: "subscription", status: "active", active: true, alias: "chatgpt-maitree", number: 5, detail: "Logged in using ChatGPT" },
        { name: "Claude (personal)", type: "subscription", status: "duplicate", active: false, alias: "claude-personal", number: 4, duplicateOf: "Claude" },
        { name: "Anthropic", type: "API key", status: "ready", active: false, alias: "anthropic", number: 2 },
      ],
      importable: [],
      labelPad: 17,
      statusPad: 9,
    },
  };
  const f = render(<Transcript items={[item]} width={120} />).lastFrame() ?? "";
  expect(f).toContain("accounts · current ChatGPT (maitree) · subscription");
  expect(f).toContain("subscriptions");
  expect(f).toContain("/account chatgpt-maitree");
  expect(f).toContain("same login as Claude");
  expect(f).toContain("api keys");
  expect(f).toContain("/account remove <name-or-number>");

  const lines = itemsToLines([item], 120);
  const text = lines.map((l) => l.map((s) => s.text).join("")).join("\n");
  expect(text).toContain("/account chatgpt-maitree");
  expect(text).toContain("api keys");
});

test("palettes render a selected row for arrow navigation", () => {
  const cmd = render(<CommandPalette draft="/c" selected={1} />).lastFrame() ?? "";
  expect(cmd).toContain("●");
  const files = render(<FilePalette matches={["a.ts", "b.ts"]} selected={1} />).lastFrame() ?? "";
  expect(files).toContain("b.ts");
  expect(files).toContain("●");
});

test("command palette rows keep selected label and detail on one row", () => {
  const rows = [
    { value: "/effort fast", label: "fast", detail: "haiku / quick bounded work" },
    { value: "/effort balanced", label: "balanced", detail: "sonnet / default coding" },
    { value: "/effort max", label: "max", detail: "opus / hardest tasks" },
  ];
  const f = render(<CommandPalette draft="/effort" rows={rows} selected={2} limit={7} />).lastFrame() ?? "";
  expect(f).toContain("● max");
  expect(f).toContain("opus / hardest tasks");
  expect(f).toContain("balanced");
});

test("app initial render: banner, demo label, empty-state hint, input", () => {
  const { lastFrame } = render(
    <App
      selector={new FixedSelector()}
      demo={true}
      runner={async ({ messages }) => ({ messages, usage: { inputTokens: 0, outputTokens: 0 } })}
    />,
  );
  const f = lastFrame() ?? "";
  expect(f).toContain("gearbox");
  expect(f).toContain("demo · no key");
  expect(f).toContain("every model");
  expect(f).toContain("ask anything");
});
