import React from "react";
import { Box, Text } from "ink";
import { color } from "../theme.ts";

// The Cost tab: the session spend + savings line, the honest routing policy, and a
// per-account spend breakdown. Every value is passed in pre-computed from real
// state (spend ledger, registry prices, prefs/caps) — this is dumb presentation.
export function CostView({
  width,
  savingsText,
  policyText,
  spendRows,
}: {
  width: number;
  savingsText: string;
  policyText: string;
  spendRows: Array<{ label: string; spent: string }>;
}) {
  return (
    <Box flexDirection="column" width={width} paddingX={1}>
      <Text color={color.accent} bold>cost</Text>
      <Box marginTop={1}>
        <Text color={color.text}>{savingsText}</Text>
      </Box>
      <Box marginTop={1}>
        <Text color={color.dim}>{policyText}</Text>
      </Box>
      {spendRows.length ? (
        <Box marginTop={1} flexDirection="column">
          <Text color={color.faint}>per account</Text>
          {spendRows.map((r) => (
            <Box key={r.label}>
              <Text color={color.dim}>{r.label.padEnd(22)}</Text>
              <Text color={color.faint}>{r.spent}</Text>
            </Box>
          ))}
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Text color={color.faint}>~ savings is an estimate vs always using the priciest model · /usage for limit bars</Text>
      </Box>
    </Box>
  );
}

// The Routing tab: the policy, what actually ran last turn, any remembered per-kind
// preferences, and a pointer to the full scorecard (/why). All real, all passed in.
export function RoutingView({
  width,
  policyText,
  lastPick,
  kindPrefs,
}: {
  width: number;
  policyText: string;
  lastPick: string | null;
  kindPrefs: Array<{ kind: string; model: string }>;
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
      {kindPrefs.length ? (
        <Box marginTop={1} flexDirection="column">
          <Text color={color.faint}>remembered preferences</Text>
          {kindPrefs.map((p) => (
            <Text key={p.kind} color={color.dim}>
              {p.kind} → {p.model}
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
