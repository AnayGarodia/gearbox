import { test, expect, describe } from "bun:test";
import { applyEdit } from "../src/edit.ts";

const FILE = `function greet(name) {
  const msg = "hello " + name;
  return msg;
}
`;

describe("applyEdit · exact matching", () => {
  test("replaces a unique exact match", () => {
    const r = applyEdit(FILE, `  return msg;`, `  return msg.trim();`, {});
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.after).toContain("return msg.trim();");
      expect(r.after).not.toContain("  return msg;\n");
      expect(r.strategy).toBe("exact");
      expect(r.replacements).toBe(1);
    }
  });

  test("fails when the text is not present at all", () => {
    const r = applyEdit(FILE, `nonexistent token`, `x`, {});
    expect(r.ok).toBe(false);
  });

  test("replaceAll replaces every exact occurrence", () => {
    const src = "a\na\na\n";
    const r = applyEdit(src, "a", "b", { replaceAll: true });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.after).toBe("b\nb\nb\n");
      expect(r.replacements).toBe(3);
    }
  });

  test("occurrence selects the Nth exact match", () => {
    const src = "x\nx\nx\n";
    const r = applyEdit(src, "x", "Y", { occurrence: 2 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.after).toBe("x\nY\nx\n");
  });

  test("rejects an occurrence beyond the match count", () => {
    const src = "x\nx\n";
    const r = applyEdit(src, "x", "Y", { occurrence: 5 });
    expect(r.ok).toBe(false);
  });
});

describe("applyEdit · whitespace-tolerant fallback", () => {
  test("matches when the find block's indentation differs from the file", () => {
    // The model supplied the body with no leading indentation; the file indents by 2.
    const find = `const msg = "hello " + name;\nreturn msg;`;
    const replace = `const msg = "hi " + name;\nreturn msg.toUpperCase();`;
    const r = applyEdit(FILE, find, replace, {});
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.strategy).toBe("whitespace");
      expect(r.after).toContain("hi ");
      expect(r.after).toContain("toUpperCase()");
      // The lines around the edit are untouched.
      expect(r.after).toContain("function greet(name) {");
      expect(r.after.trimEnd().endsWith("}")).toBe(true);
    }
  });

  test("matches when internal whitespace differs (spaces vs runs of spaces)", () => {
    const find = `const  msg  =  "hello " + name;`;
    const r = applyEdit(FILE, find, `  const msg = "yo";`, {});
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.strategy).toBe("whitespace");
      expect(r.after).toContain(`"yo"`);
    }
  });

  test("preserves a trailing newline", () => {
    const find = `return msg;`;
    const r = applyEdit(FILE, find, `return msg + "!";`, {});
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.after.endsWith("\n")).toBe(true);
  });

  test("exact wins over whitespace when both could match (no false fallback)", () => {
    const r = applyEdit(FILE, `  const msg = "hello " + name;`, `  const msg = "x";`, {});
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.strategy).toBe("exact");
  });

  test("whitespace fallback still reports ambiguity for multiple matches without occurrence", () => {
    // `a  b` (two spaces) is not an exact substring anywhere, so this only matches
    // via the normalized fallback — and both lines match, so it must refuse.
    const src = "a b\n\na b\n";
    const r = applyEdit(src, "a  b", "c", {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("ambiguous");
  });
});
