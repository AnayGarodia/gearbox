import React from "react";
import { Box, Text } from "ink";
import { color } from "../theme.ts";
import { sparkline } from "../cost-tab.ts";

// The Cost tab: daily spend bars (from the append-only ledger), the burn-rate
// forecast, the session savings line, per-model and per-account breakdowns.
// Every value is passed in pre-computed from real state — dumb presentation.
export function CostView({
  width,
  savingsText,
  policyText,
  spendRows,
  dailyBars,
  forecastText,
  perModel,
  auxToday,
}: {
  width: number;
  savingsText: string;
  policyText: string;
  spendRows: Array<{ label: string; spent: string }>;
  dailyBars?: Array<{ day: string; usd: number }>;
  forecastText?: string | null;
  perModel?: Array<{ model: string; usd: number; turns: number }>;
  auxToday?: number;
}) {
  const maxDay = Math.max(...(dailyBars ?? []).map((d) => d.usd), 0);
  return (
    <Box flexDirection="column" width={width} paddingX={1}>
      <Text color={color.accent} bold>cost</Text>
      {dailyBars?.length ? (
        <Box marginTop={1} flexDirection="column">
          <Text>
            <Text color={color.faint}>{"last 7 days  "}</Text>
            <Text color={color.text}>{sparkline(dailyBars.map((d) => d.usd))}</Text>
            <Text color={color.faint}>{"  peak $" + maxDay.toFixed(2) + " · today $" + (dailyBars[dailyBars.length - 1]?.usd ?? 0).toFixed(2)}</Text>
          </Text>
        </Box>
      ) : null}
      {forecastText ? (
        <Box marginTop={1}><Text color={color.warn}>{forecastText}</Text></Box>
      ) : null}
      {auxToday != null && auxToday > 0 ? (
        <Box marginTop={1}>
          <Text color={color.faint}>aux calls today (task classifier · titles · commit messages)  </Text>
          <Text color={color.dim}>{auxToday < 0.01 ? "<$0.01" : `$${auxToday.toFixed(2)}`}</Text>
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Text color={color.text}>{savingsText}</Text>
      </Box>
      {perModel?.length ? (
        <Box marginTop={1} flexDirection="column">
          <Text color={color.faint}>this session, by model</Text>
          {perModel.map((m) => (
            <Text key={m.model} wrap="truncate-end">
              <Text color={color.dim}>{"  " + m.model.padEnd(24)}</Text>
              <Text color={m.usd >= 0.005 ? color.text : color.faint}>{("$" + m.usd.toFixed(2)).padStart(7)}</Text>
              <Text color={color.faint}>{"  " + m.turns + " turn" + (m.turns === 1 ? "" : "s")}</Text>
            </Text>
          ))}
        </Box>
      ) : null}
      {spendRows.length ? (
        <Box marginTop={1} flexDirection="column">
          <Text color={color.faint}>per account (all sessions)</Text>
          {spendRows.map((r) => (
            <Box key={r.label}>
              <Text color={color.dim}>{"  " + r.label.padEnd(22)}</Text>
              <Text color={color.faint}>{r.spent}</Text>
            </Box>
          ))}
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Text color={color.dim}>{policyText}</Text>
      </Box>
      <Box marginTop={1}>
        <Text color={color.faint}>~ savings is an estimate vs always using the priciest model · /usage for limit bars · /cap daily enables the forecast</Text>
      </Box>
    </Box>
  );
}

// The Routing tab: the policy, the recent picks with their per-turn cost shape,
// remembered per-kind preferences, and a pointer to the full scorecard (/why).
export function RoutingView({
  width,
  policyText,
  lastPick,
  kindPrefs,
  recentTurns,
}: {
  width: number;
  policyText: string;
  lastPick: string | null;
  kindPrefs: Array<{ kind: string; model: string }>;
  recentTurns?: Array<{ model: string; usd: number }>;
}) {
  return (
    <Box flexDirection="column" width={width} paddingX={1}>
      <Text color={color.accent} bold>routing</Text>
      <Box marginTop={1}>
        <Text color={color.dim}>{policyText}</Text>
      </Box>
      {lastPick ? (
        <Box marginTop={1}>
          <Text color={color.faint}>last turn · </Text>
          <Text color={color.text}>{lastPick}</Text>
        </Box>
      ) : null}
      {recentTurns?.length ? (
        <Box marginTop={1} flexDirection="column">
          <Text>
            <Text color={color.faint}>{"recent turns  "}</Text>
            <Text color={color.text}>{sparkline(recentTurns.map((t) => t.usd))}</Text>
            <Text color={color.faint}>{"  cost shape, oldest → newest"}</Text>
          </Text>
          {recentTurns.slice(-5).map((t, i) => (
            <Text key={i} wrap="truncate-end" color={color.dim}>{"  " + t.model.padEnd(24)}{t.usd >= 0.005 ? "$" + t.usd.toFixed(2) : "<$0.01"}</Text>
          ))}
        </Box>
      ) : null}
      {kindPrefs.length ? (
        <Box marginTop={1} flexDirection="column">
          <Text color={color.faint}>remembered preferences</Text>
          {kindPrefs.map((p) => (
            <Text key={p.kind} color={color.dim}>
              {"  " + p.kind} → {p.model}
            </Text>
          ))}
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Text color={color.faint}>run /why right after a turn for the full per-candidate scorecard</Text>
      </Box>
    </Box>
  );
}
