import { describe, expect, test } from "bun:test";
import { generateSeatbeltProfile, wrapWithSandbox, escapeSeatbeltString, sandboxAvailable, SANDBOX_EXEC } from "../src/sandbox/seatbelt.ts";
import type { SandboxPolicy } from "../src/sandbox/policy.ts";

const ws = (over: Partial<SandboxPolicy> = {}): SandboxPolicy => ({
  mode: "workspace-write",
  workspace: "/tmp/ws",
  network: false,
  extraWritePaths: [],
  ...over,
});
const OPTS = { gearboxHome: "/home/u/.gearbox", tmp: "/var/folders/xx/T" };

describe("generateSeatbeltProfile", () => {
  test("workspace-write allows writes to workspace, tmp, gearbox home", () => {
    const p = generateSeatbeltProfile(ws(), OPTS);
    expect(p).toContain("(deny default)");
    expect(p).toContain("(allow file-read*)");
    expect(p).toContain('(subpath "/tmp/ws")');
    expect(p).toContain('(subpath "/private/tmp")');
    expect(p).toContain('(subpath "/var/folders/xx/T")');
    expect(p).toContain('(subpath "/home/u/.gearbox")');
    expect(p).toContain("(deny network*)");
    expect(p).not.toContain("(allow network*)");
  });
  test("read-only has no subpath write allowances, only devices", () => {
    const p = generateSeatbeltProfile(ws({ mode: "read-only" }), OPTS);
    expect(p).not.toContain('(subpath "/tmp/ws")');
    expect(p).toContain('(allow file-write* (literal "/dev/null")');
  });
  test("network allow flips the clauses", () => {
    const p = generateSeatbeltProfile(ws({ network: true }), OPTS);
    expect(p).toContain("(allow network*)");
    expect(p).toContain("(allow system-socket)");
    expect(p).not.toContain("(deny network*)");
  });
  test("extra write paths (worktree gitdir) are included and deduped", () => {
    const p = generateSeatbeltProfile(ws({ extraWritePaths: ["/repo/.git", "/tmp/ws"] }), OPTS);
    expect(p).toContain('(subpath "/repo/.git")');
    expect(p.split('(subpath "/tmp/ws")').length).toBe(2); // appears exactly once
  });
  test("paths with quotes and backslashes are escaped (no profile injection)", () => {
    const evil = '/tmp/ws") (allow file-write* (subpath "/';
    const p = generateSeatbeltProfile(ws({ workspace: evil }), OPTS);
    expect(p).toContain(escapeSeatbeltString(evil));
    expect(p).not.toContain(`(subpath "${evil}")`); // raw, unescaped form must not appear
    expect(escapeSeatbeltString('a"b\\c')).toBe('a\\"b\\\\c');
  });
});

describe("wrapWithSandbox", () => {
  const exists = (p: string) => p === SANDBOX_EXEC;
  test("identity when off", () => {
    expect(wrapWithSandbox(["/bin/sh"], ws({ mode: "off" }), { platform: "darwin", exists })).toEqual(["/bin/sh"]);
  });
  test("identity off-darwin or when sandbox-exec is missing", () => {
    expect(wrapWithSandbox(["/bin/sh"], ws(), { platform: "linux", exists })).toEqual(["/bin/sh"]);
    expect(wrapWithSandbox(["/bin/sh"], ws(), { platform: "darwin", exists: () => false })).toEqual(["/bin/sh"]);
  });
  test("wraps with sandbox-exec -p <profile> on darwin", () => {
    const argv = wrapWithSandbox(["/bin/sh"], ws(), { platform: "darwin", exists, ...OPTS });
    expect(argv[0]).toBe(SANDBOX_EXEC);
    expect(argv[1]).toBe("-p");
    expect(argv[2]).toContain("(deny default)");
    expect(argv[3]).toBe("/bin/sh");
  });
});

describe("sandboxAvailable", () => {
  test("requires darwin and the binary", () => {
    expect(sandboxAvailable("darwin", (p) => p === SANDBOX_EXEC)).toBe(true);
    expect(sandboxAvailable("linux", () => true)).toBe(false);
    expect(sandboxAvailable("darwin", () => false)).toBe(false);
  });
});
