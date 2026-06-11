// Real Seatbelt integration: spawns sandbox-exec'd shells and asserts the
// profile actually constrains writes and network. Darwin-only (skipped
// elsewhere) and slow-ish (~seconds); pure profile logic is covered in
// seatbelt-profile.test.ts.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync, realpathSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { generateSeatbeltProfile, sandboxAvailable, SANDBOX_EXEC } from "../src/sandbox/seatbelt.ts";
import type { SandboxPolicy } from "../src/sandbox/policy.ts";

const live = sandboxAvailable();
const d = live ? describe : describe.skip;

function runSandboxed(policy: SandboxPolicy, command: string): { code: number | null; out: string } {
  const profile = generateSeatbeltProfile(policy);
  const r = spawnSync(SANDBOX_EXEC, ["-p", profile, "/bin/sh", "-c", command], { encoding: "utf8", timeout: 15_000 });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

d("seatbelt integration (darwin)", () => {
  // realpath: Seatbelt matches resolved paths, and /var/folders is a symlink
  // to /private/var/folders on macOS.
  const ws = realpathSync(mkdtempSync(join(tmpdir(), "gbx-sbx-")));
  const policy: SandboxPolicy = { mode: "workspace-write", workspace: ws, network: false, extraWritePaths: [] };
  afterAll(() => rmSync(ws, { recursive: true, force: true }));

  test("write inside the workspace succeeds", () => {
    const r = runSandboxed(policy, `echo hi > "${ws}/inside.txt" && cat "${ws}/inside.txt"`);
    expect(r.code).toBe(0);
    expect(r.out).toContain("hi");
  });

  test("write outside the workspace is denied", () => {
    const target = join(homedir(), `gbx-sbx-escape-${Date.now()}.txt`);
    const r = runSandboxed(policy, `echo escape > "${target}"`);
    expect(r.code).not.toBe(0);
    expect(existsSync(target)).toBe(false);
    expect(r.out.toLowerCase()).toContain("operation not permitted");
  });

  test("read-only mode denies workspace writes too", () => {
    const r = runSandboxed({ ...policy, mode: "read-only" }, `echo hi > "${ws}/ro.txt"`);
    expect(r.code).not.toBe(0);
    expect(existsSync(join(ws, "ro.txt"))).toBe(false);
  });

  test("network is denied by default, allowed with the toggle", () => {
    const probe = `curl -m 4 -sS https://example.com -o /dev/null`;
    const denied = runSandboxed(policy, probe);
    expect(denied.code).not.toBe(0);
    const allowed = runSandboxed({ ...policy, network: true }, probe);
    // Allowed run may still fail if the host is offline; assert it is NOT a
    // resolution/permission failure, which is what the sandbox causes.
    if (allowed.code !== 0) {
      expect(allowed.out).not.toMatch(/not permitted|Could not resolve/i);
    }
  });

  test("subprocesses inherit the sandbox (pipeline escape attempt fails)", () => {
    const target = join(homedir(), `gbx-sbx-child-${Date.now()}.txt`);
    const r = runSandboxed(policy, `/bin/sh -c 'echo x > "${target}"'`);
    expect(r.code).not.toBe(0);
    expect(existsSync(target)).toBe(false);
  });

  test("git works inside a sandboxed workspace", () => {
    const r = runSandboxed(policy, `cd "${ws}" && git init -q . && git add -A 2>&1 || true; ls "${ws}/.git" >/dev/null && echo gitok`);
    expect(r.out).toContain("gitok");
  });
});
