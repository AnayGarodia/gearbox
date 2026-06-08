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
  subProbing = false,
  api,
  width,
}: {
  ctxPct: number | null;
  tokens: number;
  contextWindow?: number | null;
  cost: number;
  sub?: { name: string; limits?: LimitWindow[]; limitNote?: string } | null;
  subProbing?: boolean; // a usage probe is in flight for this account → show "checking…" not "ok"
  api?: UsageAcct | null;
  width: number;
}) {
  // Label column wide enough for the longest label we print (e.g. "Anthropic"),
  // so nothing clips to "Anthropi".
  const pad = 9;
  const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
    <Text>
      <Text color={color.faint}>{label.padEnd(pad)} </Text>
      {children}
    </Text>
  );
  return (
    <Box width={width} flexDirection="column" paddingX={1} marginTop={1}>
      <Box justifyContent="space-between">
        <Text color={color.accent} bold>usage</Text>
        <Text color={color.faint}>/usage to hide</Text>
      </Box>
      {ctxPct != null ? (
        <Row label="context">
          <Text color={color.text}>{100 - ctxPct}% left</Text>
          {/* Derive the absolute from the SAME % (≈ this turn's input) so the two
              numbers agree — `tokens` is cumulative session tokens, a different
              quantity, and showing it next to the window read as the context fill (C-D). */}
          <Text color={color.faint}>  ·  {contextWindow ? `${fmtTok(Math.round((ctxPct / 100) * contextWindow))} / ${fmtTok(contextWindow)}` : `${fmtTok(tokens)} tok`}</Text>
        </Row>
      ) : null}
      {sub?.limits?.map((l) =>
        typeof l.pct === "number" ? (
          <Row key={l.label} label={l.label}>
            <Text color={l.pct >= 90 ? color.err : color.accentDim}>{bar(100 - l.pct)}</Text>
            <Text color={l.pct >= 90 ? color.err : color.text}>  {100 - l.pct}% left</Text>
            {l.resetsIn ? <Text color={color.faint}>  ·  {l.resetsIn}</Text> : null}
          </Row>
        ) : (
          // Status-only window: no utilization number yet. While the probe is in
          // flight, show "checking…" (a clear loading state, NOT a confident "ok")
          // — the real % bar replaces it the moment the probe returns. Otherwise
          // fall back to the stream's state word.
          <Row key={l.label} label={l.label}>
            {l.status === "limited" ? (
              <Text color={color.err}>at limit{l.resetsIn ? <Text color={color.faint}>  ·  {l.resetsIn}</Text> : null}</Text>
            ) : l.status === "warn" ? (
              <Text color={color.run}>near limit{l.resetsIn ? <Text color={color.faint}>  ·  {l.resetsIn}</Text> : null}</Text>
            ) : subProbing ? (
              <Text color={color.faint}>checking…</Text>
            ) : l.resetsIn ? (
              <Text color={color.ok}>ok  <Text color={color.faint}>·  {l.resetsIn}</Text></Text>
            ) : (
              <Text color={color.ok}>ok</Text>
            )}
          </Row>
        ),
      )}
      {sub && !sub.limits?.length ? (
        <Row label="limits">
          <Text color={color.faint}>{sub.limitNote ?? "not reported yet"}</Text>
        </Row>
      ) : null}
      {api?.spend ? (
        <Row label={api.name.slice(0, pad)}>
          <Text color={api.spendPos ? color.ok : color.faint}>{api.spend}</Text>
          {api.balanceLeft ? <Text color={color.faint}>  ·  {api.balanceLeft}</Text> : null}
          {!api.balanceLeft && api.balanceNote ? <Text color={color.faint}>  ·  {api.balanceNote}</Text> : null}
        </Row>
      ) : null}
      {/* Per-minute API rate-limit headroom (from response headers) — the live
          "% used" bar for pay-per-token keys that have no 5h/weekly plan window. */}
      {api?.limits?.map((l) =>
        typeof l.pct === "number" ? (
          <Row key={`api:${l.label}`} label={l.label}>
            <Text color={l.pct >= 90 ? color.err : color.accentDim}>{bar(100 - l.pct)}</Text>
            <Text color={l.pct >= 90 ? color.err : color.text}>  {100 - l.pct}% left</Text>
            {l.resetsIn ? <Text color={color.faint}>  ·  {l.resetsIn}</Text> : null}
          </Row>
        ) : null,
      )}
      <Row label="session">
        <Text color={cost >= 0.005 ? color.text : color.faint}>${cost.toFixed(2)}</Text>
      </Row>
    </Box>
  );
}
