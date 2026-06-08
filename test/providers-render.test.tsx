import React from "react";
import { test, expect } from "bun:test";
import { render } from "ink-testing-library";
import { ProvidersView } from "../src/ui/components/ProvidersView.tsx";
import type { ProviderRowData } from "../src/ui/providers-view.ts";
import { color } from "../src/ui/theme.ts";

const ready: ProviderRowData = { id: "a", label: "anthropic", dotColor: color.ok, dotGlyph: "●", right: "$0.12 spent", broken: false };
const broken: ProviderRowData = { id: "b", label: "openai", dotColor: color.err, dotGlyph: "●", right: "balance n/a", broken: true, fixCmd: "replace the key: /account add openai <key>" };

test("renders label, money field, and the fix command for a broken account", () => {
  const out = render(<ProvidersView rows={[ready, broken]} width={70} title="providers" />).lastFrame() ?? "";
  expect(out).toContain("providers");
  expect(out).toContain("anthropic");
  expect(out).toContain("$0.12 spent");
  expect(out).toContain("balance n/a");
  expect(out).toContain("replace the key: /account add openai");
});

test("caps rows with a '+N more' overflow line", () => {
  const rows = Array.from({ length: 5 }, (_, i) => ({ ...ready, id: String(i), label: `acct-${i}` }));
  const out = render(<ProvidersView rows={rows} width={70} max={2} />).lastFrame() ?? "";
  expect(out).toContain("+3 more");
});

test("empty state points at /account add instead of inventing rows", () => {
  const out = render(<ProvidersView rows={[]} width={70} title="providers" />).lastFrame() ?? "";
  expect(out).toContain("no providers configured");
});
