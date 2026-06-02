// Model registry for the routing simulator.
// Quality priors (0-1) per task type are seeded from 2026 benchmark reality
// (e.g. DeepSeek V4-Pro ≈ Claude on SWE-bench; Opus best at architecture/reasoning;
// Flash-lite cheap but weak on hard tasks). These are the kind of priors Gearbox
// would seed from public benchmarks and then refine from a local feedback log.

export type TaskType = "boilerplate" | "docs" | "debug" | "refactor" | "architecture" | "review" | "test";

export type Model = {
  id: string;
  provider: string; // credit balances are per-provider
  blendedUSDperMTok: number; // (input+output)/2 proxy, real 2026 numbers
  quality: Record<TaskType, number>;
};

export const MODELS: Model[] = [
  { id: "claude-opus-4-8",       provider: "anthropic", blendedUSDperMTok: 15.0,
    quality: { boilerplate: .95, docs: .96, debug: .93, refactor: .94, architecture: .97, review: .95, test: .93 } },
  { id: "claude-sonnet-4-6",     provider: "anthropic", blendedUSDperMTok: 9.0,
    quality: { boilerplate: .94, docs: .95, debug: .90, refactor: .92, architecture: .93, review: .92, test: .91 } },
  { id: "claude-haiku-4-5",      provider: "anthropic", blendedUSDperMTok: 0.75,
    quality: { boilerplate: .90, docs: .92, debug: .78, refactor: .80, architecture: .68, review: .80, test: .82 } },
  { id: "gpt-5.4",               provider: "openai",    blendedUSDperMTok: 6.25,
    quality: { boilerplate: .93, docs: .94, debug: .91, refactor: .91, architecture: .94, review: .93, test: .90 } },
  { id: "gemini-2.5-pro",        provider: "google",    blendedUSDperMTok: 3.125,
    quality: { boilerplate: .92, docs: .94, debug: .88, refactor: .89, architecture: .91, review: .90, test: .89 } },
  { id: "gemini-3.1-flash-lite", provider: "google",    blendedUSDperMTok: 0.25,
    quality: { boilerplate: .88, docs: .90, debug: .72, refactor: .74, architecture: .60, review: .75, test: .78 } },
  { id: "deepseek-v4-pro",       provider: "deepseek",  blendedUSDperMTok: 0.65,
    quality: { boilerplate: .93, docs: .92, debug: .90, refactor: .91, architecture: .90, review: .91, test: .92 } },
];

// Per-provider credit balances (USD). The scenario the user named directly:
// lots of Claude credit, almost no OpenAI/Codex credit.
export const BALANCES: Record<string, number> = {
  anthropic: 10000,
  openai: 10,      // nearly empty — router must prefer Claude unless strong reason
  google: 50,
  deepseek: 20,
};
