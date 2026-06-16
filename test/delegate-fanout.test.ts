// Step 8 wiring: delegate_parallel schedules sub-tasks into WAVES via the pure
// planner — same-file tasks land in different waves and COMPOSE (each later wave
// re-seeds from the merged result), while disjoint tasks still run in one wave.
// Exercised against a real temp git repo with a stub runner that edits files.
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeDelegateTools, type SubAgentRunner } from "../src/agent/delegate.ts";
import { git } from "../src/git/ops.ts";
import { clearCooldowns } from "../src/model/cooldown.ts";

let repo: string;
const savedHome = process.env.GEARBOX_HOME;
const savedKey = process.env.ANTHROPIC_API_KEY;
const ORCH = "an unrelated long orchestrator prompt about the deploy and release pipeline";

beforeEach(() => {
  clearCooldowns();
  process.env.GEARBOX_HOME = mkdtempSync(join(tmpdir(), "gearbox-fanout-home-"));
  process.env.ANTHROPIC_API_KEY = "test-key";
  repo = mkdtempSync(join(tmpdir(), "gearbox-fanout-repo-"));
  git(["init", "-q", "-b", "main"], repo);
  git(["config", "user.email", "t@gearbox.dev"], repo);
  git(["config", "user.name", "gearbox-test"], repo);
  writeFileSync(join(repo, "shared.ts"), "base\n");
  git(["add", "-A"], repo);
  git(["commit", "-q", "-m", "init"], repo);
});
afterEach(() => {
  clearCooldowns();
  rmSync(repo, { recursive: true, force: true });
  if (savedHome === undefined) delete process.env.GEARBOX_HOME; else process.env.GEARBOX_HOME = savedHome;
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = savedKey;
});

// Reads the current shared.ts in the sub-agent's worktree, then appends a marker.
// Because a later wave's worktree is re-seeded with the prior wave's merged file,
// the appends accumulate instead of clobbering each other.
const appendRunner: SubAgentRunner = async (p) => {
  const mark = (p.prompt.match(/append (\w+)/) ?? [, "X"])[1];
  const f = join(p.root!, "shared.ts");
  const cur = (() => { try { return readFileSync(f, "utf8"); } catch { return ""; } })();
  writeFileSync(f, cur + mark + "\n");
  return { text: `appended ${mark}`, usage: { inputTokens: 1, outputTokens: 1 } };
};

test("two same-file tasks run in separate waves and COMPOSE (no conflict markers)", async () => {
  const tools = makeDelegateTools({ onEvent: () => {}, run: appendRunner, root: repo, orchestratorPrompt: ORCH });
  const out = await (tools.delegate_parallel as any).execute({
    tasks: [
      { task: "append AAA to shared.ts", kind: "code" },
      { task: "append BBB to shared.ts", kind: "code" },
    ],
  });
  const final = readFileSync(join(repo, "shared.ts"), "utf8");
  expect(final).toContain("AAA");
  expect(final).toContain("BBB"); // both survived — the second wave built on the first
  expect(final).not.toContain("<<<<<<<"); // composed, never 3-way-conflicted
  expect(String(out)).toContain("waves");
});

test("disjoint-file tasks still run together in a single parallel wave", async () => {
  const writer: SubAgentRunner = async (p) => {
    const name = (p.prompt.match(/create (\S+\.ts)/) ?? [, "x.ts"])[1]!;
    writeFileSync(join(p.root!, name), "made\n");
    return { text: `created ${name}`, usage: { inputTokens: 1, outputTokens: 1 } };
  };
  const tools = makeDelegateTools({ onEvent: () => {}, run: writer, root: repo, orchestratorPrompt: ORCH });
  const out = await (tools.delegate_parallel as any).execute({
    tasks: [
      { task: "create alpha.ts with a helper", kind: "code" },
      { task: "create beta.ts with a helper", kind: "code" },
    ],
  });
  expect(String(out)).toContain("in parallel"); // a single wave, not "waves"
  expect(readFileSync(join(repo, "alpha.ts"), "utf8")).toContain("made");
  expect(readFileSync(join(repo, "beta.ts"), "utf8")).toContain("made");
});

test("an `after` dependency sees the dependency's merged result", async () => {
  const tools = makeDelegateTools({ onEvent: () => {}, run: appendRunner, root: repo, orchestratorPrompt: ORCH });
  // task #2 depends on #1; both touch shared.ts. #2's worktree is re-seeded with
  // #1's merge, so the final file has both, in order.
  const out = await (tools.delegate_parallel as any).execute({
    tasks: [
      { task: "append FIRST to shared.ts", kind: "code" },
      { task: "append SECOND to shared.ts", kind: "code", after: [1] },
    ],
  });
  const final = readFileSync(join(repo, "shared.ts"), "utf8");
  expect(final.indexOf("FIRST")).toBeGreaterThanOrEqual(0);
  expect(final.indexOf("SECOND")).toBeGreaterThan(final.indexOf("FIRST")); // ordered
  expect(String(out)).toContain("waves");
});
