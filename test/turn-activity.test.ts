import { test, expect } from "bun:test";
import { turnActivity } from "../src/ui/App.tsx";

test("the working line surfaces a running delegate's LIVE step, not the static task text", () => {
  const items: any[] = [
    { kind: "user", id: 1, text: "research the 2026 World Cup" },
    { kind: "tool", id: 2, name: "delegate", arg: "deep research on squad market values", status: "running", startedAt: Date.now() - 9000, activity: "searching transfermarkt squad values · 12 tools" },
  ];
  const a = turnActivity(items, 90);
  expect(a.action).toContain("searching transfermarkt squad values"); // the live, changing step
  expect(a.action).not.toContain("deep research on squad market values"); // not the frozen task text
  expect(a.action).toMatch(/\d+s|\dm/); // and the ticking elapsed (a "still alive" signal)
});

test("falls back to tool + target when there is no live activity", () => {
  const items: any[] = [
    { kind: "user", id: 1, text: "fix it" },
    { kind: "tool", id: 2, name: "read_file", arg: "src/app.ts", status: "running", startedAt: Date.now() - 1000 },
  ];
  const a = turnActivity(items, 90);
  expect(a.action).toContain("read");
  expect(a.action).toContain("src/app.ts");
});
