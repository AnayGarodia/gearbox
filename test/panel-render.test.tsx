import React from "react";
import { test, expect } from "bun:test";
import { render } from "ink-testing-library";
import { Panel } from "../src/ui/components/Panel.tsx";
import type { PanelState } from "../src/ui/panel.ts";
import type { AccountView, Item } from "../src/ui/types.ts";

test("static panel shows its title, the esc affordance, and the content", () => {
  const item: Item = { kind: "notice", id: 1, text: "line one\nline two" };
  const panel: PanelState = { kind: "static", title: "help", items: [item], scroll: 0 };
  const out = render(<Panel panel={panel} width={80} height={12} />).lastFrame() ?? "";
  expect(out).toContain("help");
  expect(out).toContain("esc to close");
  expect(out).toContain("line one");
});

test("accounts panel marks the selected row and the current account", () => {
  const view: AccountView = {
    current: "Claude · subscription",
    rows: [
      { name: "Claude", type: "subscription", status: "active", active: true, alias: "claude", number: 1 },
      { name: "Anthropic", type: "API key", status: "ready", active: false, alias: "anthropic", number: 2 },
    ],
    importable: [],
    labelPad: 10,
    statusPad: 8,
  };
  const panel: PanelState = { kind: "accounts", title: "accounts", index: 1 };
  const out = render(<Panel panel={panel} width={80} height={12} accounts={view} />).lastFrame() ?? "";
  expect(out).toContain("Claude");
  expect(out).toContain("Anthropic");
  expect(out).toContain("⏎ switch");
  expect(out).toContain("▶"); // selection marker on the second row
});

test("models panel filters and shows the filter prompt", () => {
  const models = [
    { id: "claude-haiku-4-5", label: "haiku-4.5", provider: "anthropic", current: true },
    { id: "groq/llama", label: "llama-3.3", provider: "groq", current: false },
  ];
  const panel: PanelState = { kind: "models", title: "models", index: 0, filter: "haiku" };
  const out = render(<Panel panel={panel} width={80} height={12} models={models} currentModelId="claude-haiku-4-5" />).lastFrame() ?? "";
  expect(out).toContain("haiku-4.5");
  expect(out).not.toContain("llama-3.3"); // filtered out
  expect(out).toContain("filter: haiku");
  expect(out).toContain("pinned");
});
