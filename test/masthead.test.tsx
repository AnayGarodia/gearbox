import React from "react";
import { test, expect } from "bun:test";
import { render } from "ink-testing-library";
import { Masthead } from "../src/ui/components/Masthead.tsx";

test("Masthead renders the wordmark and the account on one strip, ruled under", () => {
  const out = render(<Masthead account="claude · Max" width={100} />).lastFrame() ?? "";
  expect(out).toContain("gearbox");
  expect(out).toContain("claude · Max");
  expect(out).toContain("─"); // the hairline rule under the masthead row
});

test("Masthead carries no tabs (they were removed — duplicate dashboards)", () => {
  const out = render(<Masthead account="claude · Max" width={100} />).lastFrame() ?? "";
  expect(out).not.toContain("routing");
  expect(out).not.toContain("providers");
  expect(out).not.toContain("session");
});

test("Masthead works without an account", () => {
  const out = render(<Masthead width={80} />).lastFrame() ?? "";
  expect(out).toContain("gearbox");
});
