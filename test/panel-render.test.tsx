import React from "react";
import { test, expect } from "bun:test";
import { render } from "ink-testing-library";
import { Panel } from "../src/ui/components/Panel.tsx";
import type { PanelState } from "../src/ui/panel.ts";
import type { AddSpec } from "../src/accounts/add-spec.ts";
import type { AccountView, Item } from "../src/ui/types.ts";

test("static panel shows its title, the esc affordance, and the content", () => {
  const item: Item = { kind: "notice", id: 1, text: "line one\nline two" };
  const panel: PanelState = { kind: "static", title: "help", items: [item], scroll: 0 };
  const out = render(<Panel panel={panel} width={80} height={12} />).lastFrame() ?? "";
  expect(out).toContain("help");
  expect(out).toContain("esc close");
  expect(out).toContain("line one");
});

test("accounts panel marks the selected row and the current account", () => {
  const view: AccountView = {
    current: "Claude · subscription",
    rows: [
      { name: "Claude", type: "subscription", status: "active", active: true, alias: "claude", detail: "founders@aztea.ai · Claude Max" },
      { name: "Claude (personal)", type: "subscription", status: "signed in", active: false, alias: "claude-personal", detail: "Claude Pro" },
      { name: "Anthropic", type: "API key", status: "ready", active: false, alias: "anthropic" },
    ],
    importable: [],
    labelPad: 17,
    statusPad: 8,
  };
  const panel: PanelState = { kind: "accounts", title: "accounts", index: 1 };
  const out = render(<Panel panel={panel} width={120} height={12} accounts={view} />).lastFrame() ?? "";
  expect(out).toContain("Claude");
  expect(out).toContain("Anthropic");
  expect(out).toContain("+ add an account"); // the pinned add affordance
  expect(out).toContain("⏎ select");
  expect(out).toContain("▶"); // selection marker present
  expect(out).toContain("founders@aztea.ai"); // identified seat shows its email
  // an email-less subscription seat prompts to identify it — the prompt lives on
  // the HINT LINE of the selected row now (rows stay uncrowded by design).
  const sel2: PanelState = { kind: "accounts", title: "accounts", index: 2 };
  const out2 = render(<Panel panel={sel2} width={120} height={12} accounts={view} />).lastFrame() ?? "";
  expect(out2).toContain("/account login claude-personal to identify");
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

test("wizard pick phase lists providers and narrows by the filter", () => {
  const panel: PanelState = { kind: "wizard", title: "add an account", wizardPhase: { phase: "pick", index: 0, filter: "azure" } };
  const out = render(<Panel panel={panel} width={90} height={16} />).lastFrame() ?? "";
  expect(out).toContain("Azure OpenAI");
  expect(out).toContain("Azure AI Foundry");
  expect(out).not.toContain("Anthropic"); // filtered out by "azure"
  expect(out).toContain("⏎ select");
});

test("wizard field phase shows the step, the field, an example, and prior confirmed fields", () => {
  const spec: AddSpec = {
    id: "x",
    label: "X",
    summary: "",
    group: "cloud",
    paletteCommand: "/account add x",
    fields: [
      { key: "a", label: "First", placeholder: "AKIA…", required: true, validate: () => null },
      { key: "b", label: "Second", placeholder: "us-east-1", required: true, validate: () => null },
    ],
    build: async () => ({ ok: true, message: "" }),
  };
  const panel: PanelState = {
    kind: "wizard",
    title: "add an account",
    wizardPhase: { phase: "field", specId: "x", fieldIndex: 1, fieldEdit: { value: "", cursor: 0 }, fieldError: null, filled: { a: "done" } },
  };
  const out = render(<Panel panel={panel} width={90} height={16} wizardSpec={spec} />).lastFrame() ?? "";
  expect(out).toContain("step 2 of 2");
  expect(out).toContain("Second");
  expect(out).toContain("us-east-1"); // placeholder example
  expect(out).toContain("done"); // the confirmed first field
  expect(out).toContain("esc back");
});
