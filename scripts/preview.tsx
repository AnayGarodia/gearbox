// Dev preview: render a representative session to stdout so the look can be
// reviewed without a live model. `bun run scripts/preview.tsx`
import React from "react";
import { render } from "ink-testing-library";
import { Box, Text } from "ink";
import { Banner } from "../src/ui/components/Banner.tsx";
import { Transcript } from "../src/ui/components/Transcript.tsx";
import { StatusBar } from "../src/ui/components/StatusBar.tsx";
import { CommandPalette } from "../src/ui/components/CommandPalette.tsx";
import { FilePalette } from "../src/ui/components/FilePalette.tsx";
import { Composer } from "../src/ui/components/Composer.tsx";
import { color, glyph } from "../src/ui/theme.ts";
import type { Item } from "../src/ui/types.ts";

const W = 84;

const items: Item[] = [
  { kind: "user", id: 1, text: "add a --json flag to the CLI and cover it with a test" },
  { kind: "assistant", id: 2, text: "I'll add a `--json` flag. The parse looks like:\n```ts\nconst json = args.includes(\"--json\");\n```\nThen I'll guard the render path on it.", done: true },
  { kind: "tool", id: 3, callId: "a", name: "read_file", arg: "src/cli.tsx", status: "ok", summary: "renders the Ink app · 18 lines" },
  {
    kind: "tool", id: 4, callId: "b", name: "edit_file", arg: "src/cli.tsx", status: "ok", summary: "edited src/cli.tsx (+2 −1)",
    diff: [
      { sign: "-", text: 'const demo = !anyProviderAvailable();' },
      { sign: "+", text: 'const json = args.includes("--json");' },
      { sign: "+", text: 'const demo = !anyProviderAvailable();' },
    ],
  },
  { kind: "tool", id: 5, callId: "c", name: "run_shell", arg: "bun test", status: "ok", summary: "11 pass · 0 fail" },
  { kind: "assistant", id: 6, text: "Done — added **`--json`** in cli.tsx with a passing test. Verified with `bun test`.", done: true },
];

const Preview = () => (
  <Box flexDirection="column" width={W}>
    <Banner model="sonnet-4.6" width={W} />
    <Transcript items={items} />
    <FilePalette matches={["src/ui/markdown.ts", "src/ui/components/Markdown.tsx"]} />
    <Box paddingX={1} marginTop={1}>
      <Text color={color.accent}>◆ plan mode</Text>
      <Text color={color.faint}> · read-only · shift+tab to exit</Text>
    </Box>
    <Composer value="fix the parser in @src/ui/mark" cursor={29} placeholder="" busy={false} width={W} />
    <Box paddingX={1}>
      <Text color={color.faint}>
        / commands{"  "}
        {glyph.bullet}
        {"  "}@ files{"  "}
        {glyph.bullet}
        {"  "}↑↓ history{"  "}
        {glyph.bullet}
        {"  "}⏎ send
      </Text>
    </Box>
    <StatusBar model="sonnet-4.6" cwd="gearbox" branch="main" ctxPct={7} tokens={18432} width={W} />
  </Box>
);

const { lastFrame } = render(<Preview />);
console.log(lastFrame());
