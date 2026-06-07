import { test, expect, describe, afterAll } from "bun:test";
import { tmpdir } from "node:os";
import { parseFramed, ShellSession } from "../src/shell-session.ts";

describe("parseFramed", () => {
  const S = "<<GBX:7>>";

  test("returns null until the sentinel arrives", () => {
    expect(parseFramed("partial output\n", S)).toBeNull();
  });

  test("extracts the body and exit code once the sentinel arrives", () => {
    const r = parseFramed(`hello\nworld\n${S} 0\n`, S);
    expect(r).not.toBeNull();
    expect(r!.body).toBe("hello\nworld\n");
    expect(r!.exitCode).toBe(0);
  });

  test("captures a non-zero exit code", () => {
    const r = parseFramed(`oops\n${S} 1\n`, S);
    expect(r!.exitCode).toBe(1);
  });

  test("does not treat the sentinel echoed inside body text as the frame end", () => {
    // The real sentinel line is the LAST one; a literal mention earlier shouldn't
    // end the frame prematurely (we only complete on `sentinel <number>`).
    const r = parseFramed(`talking about ${S} here\n${S} 3\n`, S);
    expect(r!.exitCode).toBe(3);
    expect(r!.body).toBe(`talking about ${S} here\n`);
  });
});

describe("ShellSession · state persistence (real shell)", () => {
  const sess = new ShellSession();
  afterAll(() => sess.close());

  test("cd persists across calls", async () => {
    const dir = tmpdir();
    await sess.run(`cd ${dir}`);
    const r = await sess.run("pwd");
    // sh's `pwd` reports the logical path, so compare against the dir as given
    // (not its realpath, which differs by macOS's /private symlink).
    expect(r.output.trim()).toBe(dir.replace(/\/$/, ""));
    expect(r.ok).toBe(true);
  });

  test("exported variables persist across calls", async () => {
    await sess.run("export GBX_TEST_VAR=hello123");
    const r = await sess.run("echo $GBX_TEST_VAR");
    expect(r.output.trim()).toBe("hello123");
  });

  test("plain shell variables persist across calls", async () => {
    await sess.run("PLAIN=keepme");
    const r = await sess.run("echo $PLAIN");
    expect(r.output.trim()).toBe("keepme");
  });

  test("a failing command reports a non-zero exit code", async () => {
    const r = await sess.run("false");
    expect(r.ok).toBe(false);
    expect(r.exitCode).not.toBe(0);
  });

  test("the sentinel framing never leaks into command output", async () => {
    const r = await sess.run("echo done");
    expect(r.output).not.toContain("GBX");
    expect(r.output.trim()).toBe("done");
  });

  test("the sentinel framing never leaks into the streamed chunks either", async () => {
    const chunks: string[] = [];
    const r = await sess.run("printf out; printf err >&2", { onChunk: (c) => chunks.push(c.text) });
    const streamed = chunks.join("");
    expect(streamed).not.toContain("GBX");
    expect(streamed).toContain("out");
    expect(streamed).toContain("err");
    expect(r.output).not.toContain("GBX");
  });

  test("a command that exits the shell is reported, and the session recovers", async () => {
    const r = await sess.run("printf bye; exit 7");
    expect(r.exitCode).toBe(7);
    expect(r.ok).toBe(false);
    expect(r.output).toContain("bye");
    // The next command works on a freshly restarted shell.
    const after = await sess.run("echo alive");
    expect(after.output.trim()).toBe("alive");
    expect(after.ok).toBe(true);
  });
});
