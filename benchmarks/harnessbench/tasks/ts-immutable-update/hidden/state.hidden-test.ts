import { expect, test } from "bun:test";
import { updateUser } from "../src/state";
const base = { id: 1, name: "Alice", email: "a@x.com", role: "user" };
test("returns a new object", () => {
  const updated = updateUser(base, { name: "Bob" });
  expect(updated).not.toBe(base);
});
test("original is not modified", () => {
  const original = { ...base };
  updateUser(base, { name: "Bob" });
  expect(base.name).toBe(original.name);
});
test("changes are applied in returned object", () => {
  const u = updateUser(base, { role: "admin", email: "b@x.com" });
  expect(u.role).toBe("admin");
  expect(u.email).toBe("b@x.com");
  expect(u.name).toBe(base.name);
});
