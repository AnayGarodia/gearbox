import { test, expect } from "bun:test";
import { currentMention, matchFiles, completeMention } from "../src/ui/mention.ts";

test("currentMention finds the @word ending at the cursor", () => {
  expect(currentMention("look at @src/cli", 16)).toEqual({ token: "src/cli", start: 8, end: 16 });
  expect(currentMention("@auth", 5)).toEqual({ token: "auth", start: 0, end: 5 });
  expect(currentMention("no mention here", 5)).toBeNull();
});

test("matchFiles ranks by match position then length", () => {
  const files = ["src/cli.tsx", "src/ui/App.tsx", "test/cli.test.ts"];
  const m = matchFiles(files, "cli");
  expect(m[0]).toBe("src/cli.tsx");
  expect(m).toContain("test/cli.test.ts");
  expect(matchFiles(files, "zzz")).toEqual([]);
});

test("completeMention swaps the token for the path", () => {
  const r = completeMention("see @cl here", { token: "cl", start: 4, end: 7 }, "src/cli.tsx");
  expect(r.value).toBe("see @src/cli.tsx  here");
  expect(r.cursor).toBe("see @src/cli.tsx ".length);
});
