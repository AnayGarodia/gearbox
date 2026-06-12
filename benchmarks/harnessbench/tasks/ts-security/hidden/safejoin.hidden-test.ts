import { expect, test } from "bun:test";
import { resolve, sep } from "node:path";
import { joinUnder } from "../src/safejoin.ts";

const root = resolve("/srv/files");
test("legit paths resolve under root", () => {
  expect(joinUnder(root, "a/b.txt")).toBe(resolve(root, "a/b.txt"));
  expect(joinUnder(root, "a/../c.txt")).toBe(resolve(root, "c.txt"));
  expect(joinUnder(root, ".")).toBe(root);
});
test("escapes throw", () => {
  for (const evil of ["../x", "a/../../etc/passwd", "../../../../etc/passwd", "/etc/passwd", "a/../..", ".."]) {
    expect(() => joinUnder(root, evil)).toThrow();
  }
});
test("prefix sibling dir does not count as inside", () => {
  // /srv/files-evil starts with /srv/files but is OUTSIDE root
  expect(() => joinUnder(root, `..${sep}files-evil${sep}x`)).toThrow();
});
