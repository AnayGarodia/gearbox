import { test, expect } from "bun:test";
import { searchHistory } from "../src/ui/history.ts";
const H = ["git status", "bun test", "git commit -m wip", "echo hi"];
test("searchHistory finds the most recent match first, cycles by idx", () => {
  expect(searchHistory(H, "git", 0)).toBe("git commit -m wip");
  expect(searchHistory(H, "git", 1)).toBe("git status");
  expect(searchHistory(H, "git", 5)).toBe("git status"); // clamps
  expect(searchHistory(H, "zzz", 0)).toBeNull();
  expect(searchHistory(H, "", 0)).toBeNull();
});
