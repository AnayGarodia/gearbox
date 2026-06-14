import { test, expect } from "bun:test";
import { itemsToLines } from "../src/ui/lines.ts";
import { createTools } from "../src/tools.ts";
import type { AgentEvent } from "../src/agent/events.ts";

test("update_plan emits a plan event the UI can render", async () => {
  const events: AgentEvent[] = [];
  const tools = createTools((e) => events.push(e));
  const out = await (tools.update_plan as any).execute({
    steps: [
      { step: "scaffold", status: "done" },
      { step: "implement parser", status: "in_progress" },
      { step: "add tests" }, // defaults to pending
    ],
  });
  expect(out).toBe("plan updated");
  const plan = events.find((e) => e.type === "plan") as Extract<AgentEvent, { type: "plan" }>;
  expect(plan).toBeTruthy();
  expect(plan.steps).toEqual([
    { text: "scaffold", status: "done" },
    { text: "implement parser", status: "in_progress" },
    { text: "add tests", status: "pending" },
  ]);
});

test("the plan item renders a checklist with progress, a current marker, and check marks", () => {
  const items: any[] = [
    { kind: "plan", id: 1, steps: [
      { text: "set up", status: "done" },
      { text: "build it", status: "in_progress" },
      { text: "test it", status: "pending" },
    ] },
  ];
  const text = itemsToLines(items, 80).map((l) => l.map((s) => s.text).join("")).join("\n");
  expect(text).toContain("plan  1/3"); // progress count
  expect(text).toContain("✓ set up"); // done is checked
  expect(text).toContain("▸ build it"); // current step marker
  expect(text).toContain("○ test it"); // pending marker
});
