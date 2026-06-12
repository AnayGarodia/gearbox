import { expect, test } from "bun:test";
import { Circle, Rectangle } from "../src/shapes.ts";
test("circle describe", () => {
  const c = new Circle(1);
  expect(c.describe()).toBe(`Shape: ${Math.PI}`);
});
test("rectangle describe", () => {
  expect(new Rectangle(3, 4).describe()).toBe("Shape: 12");
});
test("area still works directly", () => {
  expect(new Rectangle(5, 6).area()).toBe(30);
});
