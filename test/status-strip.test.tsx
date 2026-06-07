import React from "react";
import { test, expect } from "bun:test";
import { render } from "ink-testing-library";
import { StatusStrip } from "../src/ui/components/StatusStrip.tsx";

test("status strip shows context, subscription limit windows, and session spend", () => {
  const out = render(
    <StatusStrip
      ctxPct={17}
      tokens={42642}
      contextWindow={258000}
      cost={0.04}
      sub={{ name: "Claude", limits: [
        { pct: 1, label: "5h", resetsIn: "resets 5:17p" },
        { pct: 98, label: "7d", resetsIn: "resets Jun 11" },
      ] }}
      width={100}
    />,
  ).lastFrame() ?? "";
  expect(out).toContain("usage");
  expect(out).toContain("/usage to hide");
  expect(out).toContain("83% left"); // context: 100-17
  expect(out).toContain("99% left"); // 5h: 100-1
  expect(out).toContain("2% left"); // 7d: 100-98
  expect(out).toContain("resets Jun 11");
  expect(out).toContain("$0.04");
  expect(out).toContain("█"); // a bar
});

test("status strip shows a note when no quota windows are reported", () => {
  const out = render(
    <StatusStrip ctxPct={null} tokens={0} cost={0} sub={{ name: "Claude", limitNote: "hasn't reported quota windows yet" }} width={100} />,
  ).lastFrame() ?? "";
  expect(out).toContain("hasn't reported quota windows yet");
});
