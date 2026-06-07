import React from "react";
import { Box, Text } from "ink";
import { color } from "../theme.ts";
import type { LimitWindow, UsageAcct } from "../../accounts/usage.ts";

function bar(leftPct: number, cells = 12): string {
  const filled = Math.max(0, Math.min(cells, Math.round((leftPct / 100) * cells)));
  return "█".repeat(filled) + "░".repeat(cells - filled);
}
function fmtTok(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

// A persistent, toggle-able usage strip (/cost) that sits above the composer and
// does NOT capture input — you keep typing while watching context %, subscription
// 5h/7d headroom, and session spend. Closed with /cost again.
export function StatusStrip({
  ctxPct,
  tokens,
  contextWindow,
  cost,
  sub,
  api,
  width,
}: {
  ctxPct: number | null;
  tokens: number;
  contextWindow?: number | null;
  cost: number;
  sub?: { name: string; limits?: LimitWindow[]; limitNote?: string } | null;
  api?: UsageAcct | null;
  width: number;
}) {
  const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
    <Text>
      <Text color={color.faint}>{label.padEnd(8)} </Text>
      {children}
    </Text>
  );
  return (
    <Box width={width} flexDirection="column" paddingX={1} marginTop={1}>
      <Box justifyContent="space-between">
        <Text color={color.accent} bold>usage</Text>
        <Text color={color.faint}>/cost to hide</Text>
      </Box>
      {ctxPct != null ? (
        <Row label="context">
          <Text color={color.text}>{100 - ctxPct}% left</Text>
          <Text color={color.faint}>  ·  {fmtTok(tokens)}{contextWindow ? ` / ${fmtTok(contextWindow)}` : ""}</Text>
        </Row>
      ) : null}
      {sub?.limits?.map((l) => (
        <Row key={l.label} label={l.label}>
          <Text color={l.pct >= 90 ? color.err : color.accentDim}>{bar(100 - l.pct)}</Text>
          <Text color={l.pct >= 90 ? color.err : color.text}>  {100 - l.pct}% left</Text>
          {l.resetsIn ? <Text color={color.faint}>  ·  {l.resetsIn}</Text> : null}
        </Row>
      ))}
      {sub && !sub.limits?.length ? (
        <Row label="limits">
          <Text color={color.faint}>{sub.limitNote ?? "not reported yet"}</Text>
        </Row>
      ) : null}
      {api?.spend ? (
        <Row label={api.name.slice(0, 8)}>
          <Text color={api.spendPos ? color.ok : color.faint}>{api.spend}</Text>
          {api.balanceLeft ? <Text color={color.faint}>  ·  {api.balanceLeft}</Text> : null}
        </Row>
      ) : null}
      <Row label="session">
        <Text color={cost >= 0.005 ? color.text : color.faint}>${cost.toFixed(2)}</Text>
      </Row>
    </Box>
  );
}
