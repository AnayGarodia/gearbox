import React from "react";
import { test, expect } from "bun:test";
import { render } from "ink-testing-library";
import { Box } from "ink";
import { Markdown } from "../src/ui/components/Markdown.tsx";

const strip = (s: string) => s.replace(/\[[0-9;]*m/g, "");

test("renders headings, lists, tables, and inline without raw markdown markup", () => {
  const md = [
    "## Heading One",
    "",
    "Some **bold** and `code`.",
    "",
    "- first",
    "- second",
    "",
    "| Section | Summary |",
    "|---|---|",
    "| Design | routing is sacred |",
    "",
    "```ts",
    "const x = 1;",
    "```",
  ].join("\n");

  const { lastFrame } = render(
    <Box width={70}>
      <Markdown text={md} width={70} />
    </Box>,
  );
  const f = strip(lastFrame() ?? "");

  // headings/tables/lists are rendered, not shown as raw syntax
  expect(f).not.toContain("##");
  expect(f).not.toContain("|---|");
  expect(f).not.toContain("| Section |");
  // content is present
  expect(f).toContain("Heading One");
  expect(f).toContain("bold");
  expect(f).toContain("Section");
  expect(f).toContain("Summary");
  expect(f).toContain("routing is sacred");
  expect(f).toContain("first");
  expect(f).toContain("const x = 1;");
});
