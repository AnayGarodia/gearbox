import { describe, expect, test } from "bun:test";
import { resolveSandboxPolicy, parseSandboxMode, looksLikeSandboxDenial, gitDirWritePaths } from "../src/sandbox/policy.ts";

describe("parseSandboxMode", () => {
  test("accepts modes and the on alias", () => {
    expect(parseSandboxMode("off")).toBe("off");
    expect(parseSandboxMode("read-only")).toBe("read-only");
    expect(parseSandboxMode("workspace-write")).toBe("workspace-write");
    expect(parseSandboxMode("ON")).toBe("workspace-write");
    expect(parseSandboxMode("strict")).toBeNull();
    expect(parseSandboxMode(undefined)).toBeNull();
  });
});

describe("resolveSandboxPolicy", () => {
  const cwd = "/tmp/ws";
  test("default is off", () => {
    const p = resolveSandboxPolicy({}, {}, cwd, { platform: "darwin" });
    expect(p.mode).toBe("off");
    expect(p.network).toBe(false);
    expect(p.workspace).toBe("/tmp/ws");
  });
  test("prefs set the mode; env overrides prefs", () => {
    expect(resolveSandboxPolicy({ sandbox: "workspace-write" }, {}, cwd, { platform: "darwin" }).mode).toBe("workspace-write");
    expect(resolveSandboxPolicy({ sandbox: "workspace-write" }, { GEARBOX_SANDBOX: "off" }, cwd, { platform: "darwin" }).mode).toBe("off");
    expect(resolveSandboxPolicy({ sandbox: "off" }, { GEARBOX_SANDBOX: "read-only" }, cwd, { platform: "darwin" }).mode).toBe("read-only");
  });
  test("network: env beats prefs", () => {
    expect(resolveSandboxPolicy({ sandboxNetwork: true }, {}, cwd, { platform: "darwin" }).network).toBe(true);
    expect(resolveSandboxPolicy({ sandboxNetwork: true }, { GEARBOX_SANDBOX_NETWORK: "deny" }, cwd, { platform: "darwin" }).network).toBe(false);
    expect(resolveSandboxPolicy({}, { GEARBOX_SANDBOX_NETWORK: "allow" }, cwd, { platform: "darwin" }).network).toBe(true);
  });
  test("non-darwin degrades to off", () => {
    const p = resolveSandboxPolicy({ sandbox: "workspace-write" }, {}, cwd, { platform: "linux" });
    expect(p.mode).toBe("off");
  });
});

describe("gitDirWritePaths", () => {
  test("worktree pointer file yields the common .git dir", () => {
    const read = (p: string) => {
      if (p === "/ws/.git") return "gitdir: /repo/.git/worktrees/tab-fix\n";
      throw new Error("ENOENT");
    };
    expect(gitDirWritePaths("/ws", read)).toEqual(["/repo/.git"]);
  });
  test("relative gitdir resolves against the workspace", () => {
    const read = (p: string) => {
      if (p === "/ws/.git") return "gitdir: ../main/.git/worktrees/x";
      throw new Error("ENOENT");
    };
    expect(gitDirWritePaths("/ws", read)).toEqual(["/main/.git"]);
  });
  test("regular repo (.git is a directory → read throws EISDIR) yields nothing", () => {
    expect(
      gitDirWritePaths("/ws", () => {
        throw new Error("EISDIR");
      }),
    ).toEqual([]);
  });
});

describe("looksLikeSandboxDenial", () => {
  test("exit 0 is never a denial", () => {
    expect(looksLikeSandboxDenial("Operation not permitted", 0).denied).toBe(false);
  });
  test("write denials", () => {
    const r = looksLikeSandboxDenial("exit 1\ntouch: /Users/x/Desktop/f: Operation not permitted", 1);
    expect(r).toEqual({ denied: true, kind: "write" });
    expect(looksLikeSandboxDenial("Read-only file system", 1).kind).toBe("write");
  });
  test("network denials", () => {
    expect(looksLikeSandboxDenial("curl: (6) Could not resolve host: example.com", 6).kind).toBe("network");
    expect(looksLikeSandboxDenial("getaddrinfo ENOTFOUND registry.npmjs.org", 1).kind).toBe("network");
    expect(looksLikeSandboxDenial("connect ENETUNREACH 1.2.3.4:443", 1).kind).toBe("network");
  });
  test("ordinary failures are not denials", () => {
    expect(looksLikeSandboxDenial("exit 1\n3 tests failed", 1).denied).toBe(false);
    expect(looksLikeSandboxDenial("error TS2304: Cannot find name 'x'", 2).denied).toBe(false);
  });
});
