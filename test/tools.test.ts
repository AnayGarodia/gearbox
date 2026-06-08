import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
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
