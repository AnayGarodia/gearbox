import { expect, test } from "bun:test";
import { getCity } from "../src/profile";
test("null user → null", () => { expect(getCity(null)).toBeNull(); });
test("undefined user → null", () => { expect(getCity(undefined)).toBeNull(); });
test("no address → null", () => { expect(getCity({})).toBeNull(); });
test("no city → null", () => { expect(getCity({ address: {} })).toBeNull(); });
test("with city", () => { expect(getCity({ address: { city: "Paris" } })).toBe("Paris"); });
