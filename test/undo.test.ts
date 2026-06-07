import { test, expect, describe } from "bun:test";
import { recordChange, planUndo, type FileChange } from "../src/undo.ts";

const ch = (path: string, before: string, existed: boolean): FileChange => ({ path, before, existed });

describe("recordChange", () => {
  test("captures the first before-state per path and ignores later ones in the same turn", () => {
    let turn: FileChange[] = [];
    turn = recordChange(turn, ch("a.ts", "v0", true)); // pre-turn content
    turn = recordChange(turn, ch("a.ts", "v1", true)); // a second edit in the same turn
    expect(turn).toHaveLength(1);
    expect(turn[0]!.before).toBe("v0"); // undo restores to pre-turn, not the intermediate
  });

  test("tracks multiple distinct files", () => {
    let turn: FileChange[] = [];
    turn = recordChange(turn, ch("a.ts", "a0", true));
    turn = recordChange(turn, ch("b.ts", "", false));
    expect(turn.map((c) => c.path).sort()).toEqual(["a.ts", "b.ts"]);
  });
});

describe("planUndo", () => {
  test("a newly created file is deleted on undo", () => {
    const plan = planUndo([ch("new.ts", "", false)]);
    expect(plan).toEqual([{ path: "new.ts", action: "delete" }]);
  });

  test("a modified file is restored to its pre-turn content", () => {
    const plan = planUndo([ch("a.ts", "original", true)]);
    expect(plan).toEqual([{ path: "a.ts", action: "restore", content: "original" }]);
  });

  test("handles a mix in one turn", () => {
    const plan = planUndo([ch("a.ts", "orig", true), ch("new.ts", "", false)]);
    expect(plan).toContainEqual({ path: "a.ts", action: "restore", content: "orig" });
    expect(plan).toContainEqual({ path: "new.ts", action: "delete" });
  });

  test("empty turn yields an empty plan", () => {
    expect(planUndo([])).toEqual([]);
  });
});
