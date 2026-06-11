import React from "react";
import { Box, Text } from "ink";
import { color } from "../theme.ts";
import { limitColor } from "../severity.ts";
import { ShimmerText } from "./Shimmer.tsx";
import { barCells, type LimitWindow, type UsageAcct } from "../../accounts/usage.ts";

// One bar, one direction, everywhere: the fill is "% USED" colored by the
// shared severity ramp (the /usage card and lines.ts render the same way), so
// a fuller bar always means closer to the wall. The label keeps the friendly
// "% left" number — the two can't disagree, they're complements.
function UsedBar({ pct }: { pct: number }) {
  const b = barCells(pct / 100, 12);
  return (
    <Text>
      <Text color={limitColor(pct)}>{b.fill}</Text>
      <Text color={color.faint}>{b.empty}</Text>
    </Text>
  );
}
function fmtTok(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

// A persistent, toggle-able usage strip (/usage) that sits above the composer and
// does NOT capture input — you keep typing while watching context %, subscription
// 5h/7d headroom, and session spend. Closed with /usage again. (/cost is the
// separate deep money-story card.)
function StatusStripImpl({
  ctxPct,
  tokens,
  contextWindow,
  cost,
  sub,
  subProbing = false,
  api,
  apiHue,
  active,
  forecast,
  width,
}: {
  ctxPct: number | null;
  tokens: number;
  contextWindow?: number | null;
  cost: number;
  sub?: { name: string; limits?: LimitWindow[]; limitNote?: string } | null;
  subProbing?: boolean; // a usage probe is in flight for this account → show "checking…" not "ok"
  api?: UsageAcct | null;
  apiHue?: string; // provider brand hue for the api account row label
  active?: { label: string; hue: string } | null; // the live backend identity chip ("● google · API key")
  forecast?: string | null; // "≈N turns left today …" when a daily cap is set
  width: number;
  epoch?: number; // /theme invalidates the memo (setTheme mutates `color` in place)
}) {
  // Label column wide enough for the longest label we print (e.g. "Anthropic"),
  // so nothing clips to "Anthropi".
  const pad = 9;
  // wrap="truncate-end": every strip row must stay exactly ONE terminal row —
  // the footer height budget counts rows, and a wrapped line would push the
  // frame past the screen (the expensive clearTerminal path).
  const Row = ({ label, labelColor, children }: { label: string; labelColor?: string; children: React.ReactNode }) => (
    <Text wrap="truncate-end">
      <Text color={labelColor ?? color.faint}>{label.padEnd(pad)} </Text>
      {children}
    </Text>
  );
  return (
    <Box width={width} flexDirection="column" paddingX={1} marginTop={1}>
      <Box justifyContent="space-between">
        <Text>
          <Text color={color.accent} bold>usage</Text>
          {/* The live backend identity, right where you look when asking "what
              is this running on?" — provider-hue dot + name + seat/API kind. */}
          {active ? <Text color={active.hue}>{"   ● "}{active.label}</Text> : null}
        </Text>
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
            <UsedBar pct={l.pct} />
            <Text color={limitColor(l.pct)}>  {100 - l.pct}% left</Text>
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
              <Text color={color.warn}>near limit{l.resetsIn ? <Text color={color.faint}>  ·  {l.resetsIn}</Text> : null}</Text>
            ) : subProbing ? (
              <ShimmerText text="checking…" />
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
        // Full name (padEnd pads, never clips) in the provider's brand hue —
        // "Google Gemini" was truncating to "Google Ge" and reading as noise.
        <Row label={api.name} labelColor={apiHue}>
          <Text color={api.spendPos ? color.text : color.faint}>{api.spend}</Text>
          {api.balanceLeft ? <Text color={color.faint}>  ·  {api.balanceLeft}</Text> : null}
          {!api.balanceLeft && api.balanceNote ? <Text color={color.faint}>  ·  {api.balanceNote}</Text> : null}
        </Row>
      ) : null}
      {/* Per-minute API rate-limit headroom (from response headers) — the live
          "% used" bar for pay-per-token keys that have no 5h/weekly plan window. */}
      {api?.limits?.map((l) =>
        typeof l.pct === "number" ? (
          <Row key={`api:${l.label}`} label={l.label}>
            <UsedBar pct={l.pct} />
            <Text color={limitColor(l.pct)}>  {100 - l.pct}% left</Text>
            {l.resetsIn ? <Text color={color.faint}>  ·  {l.resetsIn}</Text> : null}
          </Row>
        ) : null,
      )}
      <Row label="session">
        <Text color={cost >= 0.005 ? color.text : color.faint}>${cost.toFixed(2)}</Text>
        {forecast ? <Text color={color.warn}>  ·  {forecast}</Text> : null}
      </Row>
    </Box>
  );
}

// Memoized: while pinned, the strip sat in the footer of every render (every
// scroll frame). Its object props (sub/api/forecast) come from App's memoized
// stripView/stripForecast, so their refs are stable between usage changes and
// the shallow compare holds; usage changes rebuild stripView → new refs →
// re-render, and /theme invalidates via the epoch prop.
export const StatusStrip = React.memo(StatusStripImpl);
