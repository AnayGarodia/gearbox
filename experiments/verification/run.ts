// Experiment 5 — ground-truth verification gate.
// Claim: executable tests (not LLM self-assessment) decide "done". An agent wired
// to this CANNOT present a broken or plausible-but-wrong fix as complete — directly
// attacking the #1 dev pain (11.4h/wk review burden; 43% of AI fixes need debugging).
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";

const dir = `${import.meta.dir}/repo`;
mkdirSync(dir, { recursive: true });

const TOKEN_OK = `export type Token = { sub: string; exp: number }; // exp = epoch SECONDS
export function parseToken(raw: string): Token | null {
  const [sub, expStr] = raw.split(":");
  if (!sub || !expStr) return null;
  const exp = Number(expStr);
  if (!Number.isFinite(exp)) return null;
  return { sub, exp };
}`;

// the "wrong fix" chasing the poisoned lead: fiddle parseToken (no-op on an int exp)
const TOKEN_WRONGFIX = TOKEN_OK.replace("return { sub, exp };", "return { sub, exp: Math.floor(exp) };");

const AUTH_BUGGY = `import { parseToken } from "./token";
export type Session = { userId: string; exp: number };
export function getSession(raw: string | null, now: number): Session | null {
  if (!raw) return null;
  const token = parseToken(raw);
  if (!token) return null;
  if (token.exp < now) return null; // BUG: exp is SECONDS, now is MS
  return { userId: token.sub, exp: token.exp };
}`;
const AUTH_FIXED = AUTH_BUGGY.replace("token.exp < now", "token.exp * 1000 < now");

const TEST = `import { test, expect } from "bun:test";
import { getSession } from "./auth";
const NOW_MS = 1_717_000_000_000, NOW_S = 1_717_000_000;
test("valid session is accepted", () => { expect(getSession(\`u_1:\${NOW_S + 3600}\`, NOW_MS)?.userId).toBe("u_1"); });
test("freshly issued session is accepted", () => { expect(getSession(\`u_2:\${NOW_S + 60}\`, NOW_MS)?.userId).toBe("u_2"); });
test("expired session returns null", () => { expect(getSession(\`u_1:\${NOW_S - 3600}\`, NOW_MS)).toBeNull(); });
test("missing cookie returns null", () => { expect(getSession(null, NOW_MS)).toBeNull(); });`;

writeFileSync(`${dir}/token.ts`, TOKEN_OK);
writeFileSync(`${dir}/auth.test.ts`, TEST);

function runTests(): { pass: number; fail: number; green: boolean } {
  const r = spawnSync("bun", ["test", "auth.test.ts"], { cwd: dir, encoding: "utf8" });
  const out = (r.stdout || "") + (r.stderr || "");
  const pass = Number(/(\d+) pass/.exec(out)?.[1] ?? 0);
  const fail = Number(/(\d+) fail/.exec(out)?.[1] ?? 0);
  return { pass, fail, green: fail === 0 && pass > 0 };
}

console.log("EXPERIMENT 5 — ground-truth verification gate (real `bun test`)\n");

writeFileSync(`${dir}/auth.ts`, AUTH_BUGGY);
const s1 = runTests();
console.log(`1. buggy code              → ${s1.pass} pass / ${s1.fail} fail   gate: ${s1.green ? "GREEN" : "RED — not done"}`);

writeFileSync(`${dir}/token.ts`, TOKEN_WRONGFIX);
const s2 = runTests();
console.log(`2. plausible WRONG fix      → ${s2.pass} pass / ${s2.fail} fail   gate: ${s2.green ? "GREEN" : "RED — rejected"}   (chased the poisoned lead: edited parseToken)`);

writeFileSync(`${dir}/token.ts`, TOKEN_OK);
writeFileSync(`${dir}/auth.ts`, AUTH_FIXED);
const s3 = runTests();
console.log(`3. correct fix (auth.ts)    → ${s3.pass} pass / ${s3.fail} fail   gate: ${s3.green ? "GREEN — done" : "RED"}`);

const works = !s1.green && !s2.green && s3.green;
console.log(`\nVERDICT: ${works ? "✅" : "❌"} ground truth gates 'done' — buggy RED, plausible-wrong-fix RED, correct-fix GREEN.`);
console.log(`An agent that must pass this gate cannot hand you a broken or wrong-but-plausible fix.`);
process.exit(works ? 0 : 1);
