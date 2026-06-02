import { test, expect } from "bun:test";
import { getSession } from "./auth";
const NOW_MS = 1_717_000_000_000, NOW_S = 1_717_000_000;
test("valid session is accepted", () => { expect(getSession(`u_1:${NOW_S + 3600}`, NOW_MS)?.userId).toBe("u_1"); });
test("freshly issued session is accepted", () => { expect(getSession(`u_2:${NOW_S + 60}`, NOW_MS)?.userId).toBe("u_2"); });
test("expired session returns null", () => { expect(getSession(`u_1:${NOW_S - 3600}`, NOW_MS)).toBeNull(); });
test("missing cookie returns null", () => { expect(getSession(null, NOW_MS)).toBeNull(); });