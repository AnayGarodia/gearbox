import { expect, test } from "bun:test";
import { area } from "../src/shape";
test("circle area", () => { expect(area({ kind:"circle", radius:5 })).toBeCloseTo(Math.PI*25, 5); });
test("rect area unchanged", () => { expect(area({ kind:"rect", width:4, height:3 })).toBe(12); });
test("triangle area unchanged", () => { expect(area({ kind:"triangle", base:6, height:4 })).toBe(12); });
test("circle with radius 1", () => { expect(area({ kind:"circle", radius:1 })).toBeCloseTo(Math.PI, 5); });
