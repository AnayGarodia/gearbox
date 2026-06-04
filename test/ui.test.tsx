import React from "react";
import { test, expect, beforeEach } from "bun:test";
import { render } from "ink-testing-library";
import { Transcript } from "../src/ui/components/Transcript.tsx";

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
  expect(f).toContain("read_file");
  expect(f).toContain("auth.ts");
  expect(f).toContain("42 lines");
  expect(f).toContain("run_shell");
  expect(f).toContain("rate limited");
  expect(f).toContain("▎"); // user spine
  expect(f).toContain("⏺"); // tool call marker
  expect(f).toContain("⎿"); // tool result connector
  expect(f).toContain("▲"); // error marker
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
