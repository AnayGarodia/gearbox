import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, symlinkSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTools } from "../src/tools.ts";

function tmpRepo(): string {
  return mkdtempSync(join(tmpdir(), "gb-read-"));
}

test("read_file returns a small file whole, with no footer", async () => {
  const dir = tmpRepo();
  try {
    writeFileSync(join(dir, "a.txt"), "one\ntwo\nthree");
    const tools = createTools(undefined, dir);
    const out = await (tools.read_file as any).execute({ path: "a.txt" });
    expect(out).toBe("one\ntwo\nthree");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("read_file with offset/limit returns just the range plus a 'showing lines' footer", async () => {
  const dir = tmpRepo();
  try {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n");
    writeFileSync(join(dir, "b.txt"), lines);
    const tools = createTools(undefined, dir);
    const out = await (tools.read_file as any).execute({ path: "b.txt", offset: 10, limit: 3 });
    expect(out).toContain("line 10");
    expect(out).toContain("line 12");
    expect(out).not.toContain("line 13");
    expect(out).toContain("showing lines 10-12 of 50");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("read_file caps a huge file at the default line cap and signals there is more", async () => {
  const dir = tmpRepo();
  try {
    const lines = Array.from({ length: 2500 }, (_, i) => `L${i + 1}`).join("\n");
    writeFileSync(join(dir, "big.txt"), lines);
    const tools = createTools(undefined, dir);
    const out = await (tools.read_file as any).execute({ path: "big.txt" });
    expect(out).toContain("L1");
    expect(out).toContain("L2000");
    expect(out).not.toContain("L2001");
    expect(out).toContain("showing lines 1-2000 of 2500");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a symlink escaping the workspace is refused for read and write", async () => {
  const outside = tmpRepo();
  const dir = tmpRepo();
  try {
    writeFileSync(join(outside, "secret.txt"), "secret");
    symlinkSync(join(outside, "secret.txt"), join(dir, "link.txt")); // file link → outside
    symlinkSync(outside, join(dir, "outdir")); // dir link → outside
    const tools = createTools(undefined, dir);
    await expect((tools.read_file as any).execute({ path: "link.txt" })).rejects.toThrow("escapes workspace");
    await expect((tools.write_file as any).execute({ path: "link.txt", content: "x" })).rejects.toThrow("escapes workspace");
    // A NEW file under an escaping symlinked dir must also be refused.
    await expect((tools.write_file as any).execute({ path: "outdir/new.txt", content: "x" })).rejects.toThrow("escapes workspace");
    expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe("secret"); // untouched
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("normal relative paths still work, including writing a NEW file", async () => {
  const dir = tmpRepo();
  try {
    const tools = createTools(undefined, dir);
    const r = await (tools.write_file as any).execute({ path: "new.txt", content: "hello" });
    expect(r.summary).toContain("wrote new.txt");
    expect(await (tools.read_file as any).execute({ path: "new.txt" })).toBe("hello");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a workspace whose ROOT is behind a symlink still works", async () => {
  const real = tmpRepo();
  const parent = tmpRepo();
  const linkRoot = join(parent, "ws");
  try {
    symlinkSync(real, linkRoot);
    writeFileSync(join(real, "a.txt"), "hi");
    const tools = createTools(undefined, linkRoot);
    expect(await (tools.read_file as any).execute({ path: "a.txt" })).toBe("hi");
    const r = await (tools.write_file as any).execute({ path: "b.txt", content: "new" });
    expect(r.summary).toContain("wrote b.txt");
    expect(readFileSync(join(real, "b.txt"), "utf8")).toBe("new");
  } finally {
    rmSync(parent, { recursive: true, force: true });
    rmSync(real, { recursive: true, force: true });
  }
});

test("a symlink inside the workspace pointing WITHIN it is allowed", async () => {
  const dir = realpathSync(tmpRepo());
  try {
    writeFileSync(join(dir, "real.txt"), "inside");
    symlinkSync(join(dir, "real.txt"), join(dir, "alias.txt"));
    const tools = createTools(undefined, dir);
    expect(await (tools.read_file as any).execute({ path: "alias.txt" })).toBe("inside");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("read_file past the end of the file is a graceful message, not a throw", async () => {
  const dir = tmpRepo();
  try {
    writeFileSync(join(dir, "c.txt"), "only\ntwo");
    const tools = createTools(undefined, dir);
    const out = await (tools.read_file as any).execute({ path: "c.txt", offset: 99 });
    expect(out).toContain("past the end");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
