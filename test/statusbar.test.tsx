import React from "react";
import { test, expect } from "bun:test";
import { render } from "ink-testing-library";
import { StatusBar } from "../src/ui/components/StatusBar.tsx";

test("status bar shows the offline chip only when offline", () => {
  const base = { model: "claude", branch: "main", ctxPct: 10, tokens: 100, width: 100 };
  const on = render(<StatusBar {...base} online={true} />).lastFrame() ?? "";
  expect(on).not.toContain("offline");
  const off = render(<StatusBar {...base} online={false} />).lastFrame() ?? "";
  expect(off).toContain("offline");
});
