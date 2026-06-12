import { expect, test } from "bun:test";
import { log } from "./logger";
// Existing test — must keep passing per the task requirement.
test("log entry contains timestamp", () => {
  const entry = log("info", "hello");
  expect(typeof entry.timestamp).toBe("number");
});
