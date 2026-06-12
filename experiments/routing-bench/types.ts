// Shared shapes for the routing bench.

export interface HiddenJudge {
  kind: "bun" | "python"; // bun → `bun test <file>`; python → `python3 <file>` (unittest.main)
  file: string; // written into the workspace AFTER the agent run
  content: string;
}

export interface BenchTask {
  id: string;
  tier: "T1" | "T2" | "T3";
  // true → the workspace ships a test script + visible tests, so the agent's
  // VERIFY gate works (tests-tier routing). false → no checks at all
  // (none-tier routing); only the hidden judge measures quality.
  visible: boolean;
  prompt: string;
  files: Record<string, string>;
  hidden: HiddenJudge;
}

export interface BenchRow {
  task: string;
  tier: string;
  visible: boolean;
  policy: string;
  hiddenOk: boolean; // the judge's verdict — THE quality signal
  agentOk: boolean; // what the agent believed (its own verify loop)
  costUSD: number;
  wallMs: number;
  inputTokens: number;
  outputTokens: number;
  attempts: number;
  models: string[];
  kind?: string;
  verifierTier?: string;
  error?: string;
}
