import { expect, test } from "bun:test";
import { getDisplayName } from "../src/user";

test("null user returns empty string", () => {
  expect(getDisplayName(null)).toBe("");
});

test("undefined user returns empty string", () => {
  expect(getDisplayName(undefined)).toBe("");
});

test("full name", () => {
  expect(getDisplayName({ firstName: "Alice", lastName: "Smith" })).toBe("Alice Smith");
});

test("first name only", () => {
  expect(getDisplayName({ firstName: "Alice" })).toBe("Alice");
});

test("last name only", () => {
  expect(getDisplayName({ lastName: "Smith" })).toBe("Smith");
});
