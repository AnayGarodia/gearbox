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

test("typing while busy shows the steer affordance instead of freezing", () => {
  const out = render(
    <Composer value="next task" cursor={9} placeholder="ask anything" busy={true} width={80} />,
  ).lastFrame() ?? "";
  expect(out).toContain("next task");
  expect(out).toContain("steers");
});

test("empty composer while busy invites steering", () => {
  const out = render(
    <Composer value="" cursor={0} placeholder="ask anything" busy={true} width={80} />,
  ).lastFrame() ?? "";
  expect(out).toContain("type to steer");
});

test("the footer hint line shows the routing policy under the box (branch lives on the meter)", () => {
  const out = render(
    <Composer value="" cursor={0} placeholder="ask anything" busy={false} width={80} policy="auto-route" branch="main" />,
  ).lastFrame() ?? "";
  expect(out).toContain("auto-route");
  expect(out).not.toContain("⎇"); // branch is said ONCE, on the meter's cwd:branch
  expect(out).toContain("┃"); // thick left + right edges (the opencode editor box)
  expect(out).toContain("⏎ send"); // idle contextual hint
});

test("the footer hint line shows provider dim + model on the right", () => {
  const out = render(
    <Composer value="" cursor={0} placeholder="ask anything" busy={false} width={80} provider="anthropic" model="sonnet-4.6" />,
  ).lastFrame() ?? "";
  expect(out).toContain("anthropic");
  expect(out).toContain("sonnet-4.6");
});

test("busy with an empty composer shows the working hint on the footer line", () => {
  const out = render(
    <Composer value="" cursor={0} placeholder="ask anything" busy={true} width={80} />,
  ).lastFrame() ?? "";
  expect(out).toContain("type to steer"); // esc/elapsed live in the now-row — said once
});

test("a pinned policy shows the model as the policy, not a second model name", () => {
  const out = render(
    <Composer value="" cursor={0} placeholder="ask anything" busy={false} width={80} policy="pinned sonnet-4.6" branch="main" />,
  ).lastFrame() ?? "";
  expect(out).toContain("pinned sonnet-4.6");
});

test("no policy prop means no policy line (e.g. during onboarding)", () => {
  const out = render(
    <Composer value="" cursor={0} placeholder="ask anything" busy={false} width={80} />,
  ).lastFrame() ?? "";
  expect(out).not.toContain("auto-route");
});

test("plan / auto-accept wear the composer: a footer badge, no transcript line needed", () => {
  const plan = render(
    <Composer value="" cursor={0} placeholder="ask anything" busy={false} width={80} mode="plan" />,
  ).lastFrame() ?? "";
  expect(plan).toContain("plan");
  const auto = render(
    <Composer value="" cursor={0} placeholder="ask anything" busy={false} width={80} mode="auto-accept" />,
  ).lastFrame() ?? "";
  expect(auto).toContain("auto-accept");
  const normal = render(
    <Composer value="" cursor={0} placeholder="ask anything" busy={false} width={80} mode="normal" />,
  ).lastFrame() ?? "";
  expect(normal).not.toContain("plan");
  expect(normal).not.toContain("auto-accept");
});

test("bash mode beats the mode badge (it's about THIS line)", () => {
  const out = render(
    <Composer value="" cursor={0} placeholder="" busy={false} width={80} bashMode={true} mode="plan" />,
  ).lastFrame() ?? "";
  expect(out).toContain("! bash");
  // the footer badge slot is single-occupancy; plan shows via the edges only
  expect(out).not.toContain("plan");
});
