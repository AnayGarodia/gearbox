import React from "react";
import { test, expect } from "bun:test";
import { render } from "ink-testing-library";
import { Transcript } from "../src/ui/components/Transcript.tsx";
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
  expect(f).toContain("read_file");
  expect(f).toContain("auth.ts");
  expect(f).toContain("42 lines");
  expect(f).toContain("run_shell");
  expect(f).toContain("rate limited");
  expect(f).toContain("✓");
  expect(f).toContain("✗");
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
  expect(f).toContain("Ready when you are");
  expect(f).toContain("ask gearbox");
});
