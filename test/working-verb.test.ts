import { test, expect } from "bun:test";
import { toolVerbFromName, lowContextNotice } from "../src/ui/character.ts";

test("toolVerbFromName maps tool names to the present action verb (case-insensitive)", () => {
  expect(toolVerbFromName("read_file")).toBe("Reading");
  expect(toolVerbFromName("Read")).toBe("Reading");
  expect(toolVerbFromName("write_file")).toBe("Writing");
  expect(toolVerbFromName("file_change")).toBe("Writing");
  expect(toolVerbFromName("edit_file")).toBe("Editing");
  expect(toolVerbFromName("run_shell")).toBe("Running");
  expect(toolVerbFromName("command_execution")).toBe("Running");
  expect(toolVerbFromName("Bash")).toBe("Running");
  expect(toolVerbFromName("list_dir")).toBe("Listing");
  expect(toolVerbFromName("glob")).toBe("Globbing");
  expect(toolVerbFromName("search")).toBe("Searching");
  expect(toolVerbFromName("delegate")).toBe("Delegating");
  expect(toolVerbFromName("delegate_parallel")).toBe("Delegating");
});

test("toolVerbFromName falls back to 'Working' for unknown tools (never guesses)", () => {
  expect(toolVerbFromName("some_mcp_tool_xyz")).toBe("Working");
});

test("lowContextNotice is null until the context is genuinely low", () => {
  expect(lowContextNotice(null)).toBeNull(); // no usage reported yet
  expect(lowContextNotice(0)).toBeNull();
  expect(lowContextNotice(50)).toBeNull();
  expect(lowContextNotice(84)).toBeNull(); // 16% left — not yet low
});

test("lowContextNotice surfaces the remaining % + the fix command once low (≥85% used)", () => {
  expect(lowContextNotice(85)).toContain("15% context left");
  expect(lowContextNotice(90)).toContain("10% context left");
  expect(lowContextNotice(99)).toContain("1% context left");
  expect(lowContextNotice(100)).toContain("0% context left");
  expect(lowContextNotice(90)).toContain("/compact"); // the fix
});
