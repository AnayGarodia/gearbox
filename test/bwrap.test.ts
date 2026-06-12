// Pure bwrap argv construction — the Linux mirror of seatbelt-profile tests.
import { describe, expect, test } from "bun:test";
import { generateBwrapArgs, wrapWithBwrap, bwrapAvailable, BWRAP_CANDIDATES } from "../src/sandbox/bwrap.ts";
import { wrapWithSandbox } from "../src/sandbox/index.ts";
import type { SandboxPolicy } from "../src/sandbox/policy.ts";

const policy = (over: Partial<SandboxPolicy> = {}): SandboxPolicy => ({
  mode: "workspace-write",
  workspace: "/home/u/proj",
  network: false,
  extraWritePaths: [],
  ...over,
});

const existsBwrap = (p: string) => p === "/usr/bin/bwrap";

describe("generateBwrapArgs", () => {
  test("workspace-write binds the workspace writable over a read-only root", () => {
    const args = generateBwrapArgs(policy())!;
    expect(args.slice(0, 3)).toEqual(["--ro-bind", "/", "/"]);
    const s = args.join(" ");
    expect(s).toContain("--bind-try /home/u/proj /home/u/proj");
    expect(s).toContain("--die-with-parent");
    expect(s).toContain("--unshare-net");
  });
  test("read-only mode has no write binds", () => {
    const s = generateBwrapArgs(policy({ mode: "read-only" }))!.join(" ");
    expect(s).not.toContain("--bind-try");
    expect(s).toContain("--ro-bind / /");
  });
  test("network allow drops --unshare-net", () => {
    const s = generateBwrapArgs(policy({ network: true }))!.join(" ");
    expect(s).not.toContain("--unshare-net");
  });
  test("extra write paths are bound; darwin /private spellings are dropped", () => {
    const s = generateBwrapArgs(policy({ extraWritePaths: ["/repo/.git"] }))!.join(" ");
    expect(s).toContain("--bind-try /repo/.git /repo/.git");
    expect(s).not.toContain("/private/tmp");
  });
  test("off yields null", () => {
    expect(generateBwrapArgs(policy({ mode: "off" }))).toBeNull();
  });
});

describe("wrapWithBwrap", () => {
  const argv = ["/bin/sh"];
  test("wraps when bwrap exists on linux", () => {
    const w = wrapWithBwrap(argv, policy(), { platform: "linux", exists: existsBwrap });
    expect(w[0]).toBe("/usr/bin/bwrap");
    expect(w.at(-1)).toBe("/bin/sh");
  });
  test("identity when bwrap is missing, policy off, or platform is not linux", () => {
    expect(wrapWithBwrap(argv, policy(), { platform: "linux", exists: () => false })).toEqual(argv);
    expect(wrapWithBwrap(argv, policy({ mode: "off" }), { platform: "linux", exists: existsBwrap })).toEqual(argv);
    expect(wrapWithBwrap(argv, policy(), { platform: "darwin", exists: existsBwrap })).toEqual(argv);
  });
});

describe("wrapWithSandbox dispatcher", () => {
  test("linux routes to bwrap, darwin to seatbelt, others identity", () => {
    const argv = ["/bin/sh"];
    expect(wrapWithSandbox(argv, policy(), { platform: "linux", exists: existsBwrap })[0]).toBe("/usr/bin/bwrap");
    const darwin = wrapWithSandbox(argv, policy(), { platform: "darwin", exists: (p) => p === "/usr/bin/sandbox-exec" });
    expect(darwin[0]).toBe("/usr/bin/sandbox-exec");
    expect(wrapWithSandbox(argv, policy(), { platform: "win32", exists: () => true })).toEqual(argv);
  });
});

describe("bwrapAvailable", () => {
  test("linux + candidate present", () => {
    expect(bwrapAvailable("linux", existsBwrap)).toBe(true);
    expect(bwrapAvailable("linux", () => false)).toBe(false);
    expect(bwrapAvailable("darwin", existsBwrap)).toBe(false);
    expect(BWRAP_CANDIDATES).toContain("/usr/bin/bwrap");
  });
});
