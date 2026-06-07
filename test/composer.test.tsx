import React from "react";
import { test, expect } from "bun:test";
import { render } from "ink-testing-library";
import { Composer } from "../src/ui/components/Composer.tsx";

test("shell mode shows a bash badge and a run hint", () => {
  const out = render(
    <Composer value="!git status" cursor={11} placeholder="ask anything" busy={false} width={80} />,
  ).lastFrame() ?? "";
  expect(out).toContain("! bash");
  expect(out).toContain("runs in your shell");
});

test("plain input shows neither bash badge nor shell hint", () => {
  const out = render(
    <Composer value="hello there" cursor={11} placeholder="ask anything" busy={false} width={80} />,
  ).lastFrame() ?? "";
  expect(out).not.toContain("bash");
  expect(out).not.toContain("runs in your shell");
});

test("typing while busy shows the queue affordance instead of freezing", () => {
  const out = render(
    <Composer value="next task" cursor={9} placeholder="ask anything" busy={true} width={80} />,
  ).lastFrame() ?? "";
  expect(out).toContain("next task");
  expect(out).toContain("queues");
});

test("empty composer while busy invites queueing", () => {
  const out = render(
    <Composer value="" cursor={0} placeholder="ask anything" busy={true} width={80} />,
  ).lastFrame() ?? "";
  expect(out).toContain("type to queue");
});
