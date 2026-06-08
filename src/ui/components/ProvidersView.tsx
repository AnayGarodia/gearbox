import React from "react";
import { Box, Text } from "ink";
import { color, glyph } from "../theme.ts";
import type { ProviderRowData } from "../providers-view.ts";

// Renders the providers list: a status dot, the label, the honest money field, and
// (for a broken account) the exact fix command. Pure presentation over real rows
// from buildProvidersView — reused by the cold-open block and the Providers tab.
export function ProvidersView({
  rows,
  width,
  title,
  max,
}: {
  rows: ProviderRowData[];
  width: number;
  title?: string;
  max?: number; // cap the rows shown (cold-open); the rest collapse to "+N more"
}) {
  if (!rows.length) {
    return (
      <Box flexDirection="column" width={width}>
        {title ? <Text color={color.faint}>{title}</Text> : null}
        <Text color={color.faint}>no providers configured · /account add &lt;provider&gt; &lt;key&gt;</Text>
      </Box>
    );
  }
  const shown = max ? rows.slice(0, max) : rows;
  const overflow = rows.length - shown.length;
  const labelPad = Math.max(...rows.map((r) => r.label.length));
  return (
    <Box flexDirection="column" width={width}>
      {title ? <Text color={color.faint}>{title}</Text> : null}
      {shown.map((r) => (
        <Box key={r.id}>
          <Text color={r.dotColor}>{r.dotGlyph} </Text>
          <Text color={color.text}>{r.label.padEnd(labelPad)}</Text>
          {r.right ? <Text color={color.faint}>{"  " + r.right}</Text> : null}
          {r.fixCmd ? <Text color={color.warn}>{`  ${glyph.bullet}  ${r.fixCmd}`}</Text> : null}
        </Box>
      ))}
      {overflow > 0 ? <Text color={color.faint}>{`  +${overflow} more · /account`}</Text> : null}
    </Box>
  );
}
