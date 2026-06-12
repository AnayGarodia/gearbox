// Headless verified turn — the full agent loop without the UI: classify →
// select (any routing policy) → run → VERIFY → auto-fix/escalate, returning a
// structured result. This is what `gearbox -p "…" --verify` runs and what the
// routing bench (experiments/routing-bench) measures: the plain `-p` path is a
// single completion with no verification, which can't exercise escalation or
// cascade policies at all.
//
// The cascade policies' turn-shape drivers live here too, keyed off the
// selector's `cascade` marker (src/model/policies/cascade.ts):
//   selfverify   — after a cheap draft in an UNVERIFIED workspace, the draft
//                  model judges its own work (AutoMix-style); a FAIL verdict
//                  escalates exactly like a failed check.
//   draft-review — the strongest available model reviews the draft's diff
//                  (mostly input tokens, ≪ generation); a REJECT escalates
//                  with the review notes as the fix brief.
import { spawnSync } from "node:child_process";
import type { ModelMessage } from "ai";
import { runTask, runCompletion } from "./run.ts";
import { classifyTask } from "./classify.ts";
import { buildContext } from "../context/builder.ts";
import { resolveCreds } from "../accounts/resolve.ts";
import { defaultAccount } from "../accounts/store.ts";
import { recordSpend, resolveTurnCost } from "../accounts/ledger.ts";
import {
  detectVerificationCommands, runVerification, detectProofTier, worstFailureKind,
  buildFixPrompt, provenTier, checkIntent, MAX_AUTOFIX_ATTEMPTS,
} from "../verify.ts";
import { recordTurnOutcome } from "../model/priors.ts";
import { recordRoutingOutcome } from "../model/outcomes.ts";
import { terms } from "../context/retrieve.ts";
import { selectorForPolicy } from "../model/policy.ts";
import type { ModelSelector, Task, FailureKind, VerifierTier } from "../model/selector.ts";
import type { OnEvent } from "./events.ts";

export interface HeadlessAttempt {
  model: string;
  escalate: number;
  failureKind?: FailureKind;
  reason: string;
  usage: { inputTokens: number; outputTokens: number };
  costUSD?: number;
  wallMs: number;
  checks: string[];
  failures: string[];
  aux?: { role: "self-check" | "review"; model: string; verdict: "pass" | "reject"; costUSD?: number };
}

export interface HeadlessResult {
  ok: boolean;
  text: string;
  policy: string;
  kind: string;
  verifierTier: VerifierTier;
  proofTier: string; // what the final state actually proved (tests | types | none)
  attempts: HeadlessAttempt[];
  changedFiles: string[];
  totals: { inputTokens: number; outputTokens: number; costUSD: number; wallMs: number };
  error?: string;
}

const REVIEW_SYSTEM = [
  "You are a strict senior code reviewer. You receive a task and the diff a cheaper model produced for it.",
  "Judge ONLY whether the diff plausibly accomplishes the task without breaking anything obvious.",
  "Reply with exactly one line: 'APPROVE' or 'REJECT: <one-sentence reason>'. Nothing else.",
].join("\n");

const SELFCHECK_SYSTEM = [
  "You wrote the change in the diff below for the given task. Re-read it skeptically, as if reviewing a stranger's work.",
  "Look for: the task not actually being accomplished, syntax errors, broken references, missed edge cases the task names.",
  "Reply with exactly one line: 'PASS' or 'FAIL: <one-sentence reason>'. Nothing else.",
].join("\n");

// Changed-file tracking that works for both backends: in-loop turns emit
// file-change events; a git workspace also gets a porcelain snapshot diff so
// shell-side writes (and CLI-seat turns) are still seen.
function gitDirty(cwd: string): Set<string> {
  try {
    const r = spawnSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8", timeout: 10_000 });
    if (r.status !== 0) return new Set();
    return new Set(
      r.stdout.split("\n").map((l) => l.slice(3).trim()).filter(Boolean).map((f) => f.replace(/^.* -> /, "")),
    );
  } catch {
    return new Set();
  }
}

function gitDiffText(cwd: string, maxChars = 12_000): string {
  try {
    const r = spawnSync("git", ["diff"], { cwd, encoding: "utf8", timeout: 10_000, maxBuffer: 4 * 1024 * 1024 });
    const out = r.status === 0 ? r.stdout : "";
    return out.length > maxChars ? out.slice(0, maxChars) + "\n… (diff truncated)" : out;
  } catch {
    return "";
  }
}

async function auxCompletion(opts: {
  selector: ModelSelector; system: string; prompt: string; kindHint: Task["kind"]; strong: boolean; onEvent: OnEvent;
}): Promise<{ text: string; model: string; costUSD?: number } | null> {
  try {
    const sel = opts.strong ? selectorForPolicy("fixed-strong") : opts.selector;
    const choice = sel.select({ prompt: opts.prompt, kind: opts.kindHint });
    if (choice.backend?.kind === "cli") return null; // completions need an in-loop model
    const acct = (choice.backend?.kind === "in-loop" && choice.backend.account) || defaultAccount(choice.model.provider);
    const creds = acct ? await resolveCreds(acct) : undefined;
    const r = await runCompletion({ model: choice.model, system: opts.system, prompt: opts.prompt, onEvent: () => {}, creds, maxRetries: 2 });
    const ev = recordSpend({
      accountId: acct?.id ?? `env:${choice.model.provider}`, model: choice.model.id, source: "aux",
      inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens,
      ...resolveTurnCost({ modelId: choice.model.id, isSub: false, usage: r.usage }), at: Date.now(),
    });
    return { text: r.text, model: choice.model.id, costUSD: ev.costUSD };
  } catch {
    return null; // a broken aux check never blocks the turn — fall through as "approved"
  }
}

export async function runHeadlessTurn(opts: {
  prompt: string;
  selector?: ModelSelector; // defaults to the GEARBOX_ROUTER policy (baseline when unset)
  cwd?: string;
  verify?: boolean; // run the detect → verify → auto-fix loop (default true)
  maxAttempts?: number; // fix attempts after the first try (default MAX_AUTOFIX_ATTEMPTS)
  capUSD?: number; // stop escalating once the turn's accumulated spend crosses this
  onEvent?: OnEvent; // optional passthrough for debugging/streaming
  signal?: AbortSignal;
}): Promise<HeadlessResult> {
  const cwd = opts.cwd ?? process.cwd();
  const selector = opts.selector ?? selectorForPolicy();
  const policy = (selector as { policyName?: string }).policyName ?? "pinned";
  const cascade = (selector as { cascade?: "selfverify" | "draft-review" }).cascade;
  const doVerify = opts.verify !== false;
  const maxAttempts = opts.maxAttempts ?? MAX_AUTOFIX_ATTEMPTS;
  const onEvent: OnEvent = opts.onEvent ?? (() => {});
  const startedAll = Date.now();

  // Policies that classify themselves (observables/combined) skip the LLM hop.
  const kind = (selector as { classifiesItself?: boolean }).classifiesItself
    ? undefined
    : await classifyTask(opts.prompt, opts.signal);
  const verifierTier = detectProofTier(cwd);

  const attempts: HeadlessAttempt[] = [];
  const changedFiles = new Set<string>();
  const baseline = gitDirty(cwd);
  let history: ModelMessage[] = [];
  let turnPrompt = opts.prompt;
  let failureKind: FailureKind | undefined;
  let text = "";
  let resolvedKind: string = kind ?? "code";
  let error: string | undefined;
  let proof: string = "none";
  const totals = { inputTokens: 0, outputTokens: 0, costUSD: 0, wallMs: 0 };
  const overCap = () => opts.capUSD !== undefined && totals.costUSD >= opts.capUSD;

  for (let attempt = 0; ; attempt++) {
    const started = Date.now();
    const task: Task = {
      prompt: turnPrompt, kind, requires: ["tools"], verifierTier,
      escalate: attempt, failureKind: attempt > 0 ? failureKind : undefined,
    };
    let choice;
    try {
      choice = selector.select(task);
    } catch {
      choice = selector.select({ ...task, requires: undefined }); // subscription-only setups
    }
    resolvedKind = (choice.reason.split(" ")[0] as string) || resolvedKind;

    let usage = { inputTokens: 0, outputTokens: 0 };
    let failureMsg: string | undefined;
    let attemptText = "";
    let attemptCost: number | undefined;
    const collect: OnEvent = (e) => {
      if (e.type === "text") attemptText += e.text;
      else if (e.type === "file-change") changedFiles.add(e.path);
      onEvent(e);
    };

    if (choice.backend?.kind === "cli") {
      const { runCliTask } = await import("./cli-backend.ts");
      const r = await runCliTask({
        binary: choice.backend.binary, profile: choice.backend.profile, prompt: turnPrompt, messages: history,
        onEvent: collect, deferTerminal: true, autoApprove: true,
      });
      usage = r.usage;
      history = r.messages;
      failureMsg = r.failure?.message;
      const ev = recordSpend({
        accountId: choice.backend.account.id, model: choice.model.id, source: "turn",
        inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
        ...resolveTurnCost({ modelId: choice.model.id, isSub: true, cliCostUSD: r.costUSD, usage }), at: Date.now(),
      });
      attemptCost = ev.costUSD;
      totals.costUSD += ev.costUSD ?? 0;
    } else {
      const acct = (choice.backend?.kind === "in-loop" && choice.backend.account) || defaultAccount(choice.model.provider);
      const creds = acct ? await resolveCreds(acct) : undefined;
      const built = buildContext({ history, userText: turnPrompt, model: choice.model, plan: false });
      const r = await runTask({
        model: choice.model, messages: built.messages, system: built.system, creds, cacheBreak: built.cacheBreak,
        onEvent: collect, signal: opts.signal, plan: false, deferTerminal: true, maxRetries: 2, root: cwd,
      });
      usage = r.usage;
      failureMsg = r.failure?.message;
      history = [...history, { role: "user", content: turnPrompt }, ...r.messages.slice(built.messages.length)];
      const ev = recordSpend({
        accountId: acct?.id ?? `env:${choice.model.provider}`, model: choice.model.id, source: "turn",
        inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
        ...resolveTurnCost({ modelId: choice.model.id, isSub: false, usage }), at: Date.now(),
      });
      attemptCost = ev.costUSD;
      totals.costUSD += ev.costUSD ?? 0;
    }
    totals.inputTokens += usage.inputTokens;
    totals.outputTokens += usage.outputTokens;
    text = attemptText || text;

    const rec: HeadlessAttempt = {
      model: choice.model.id, escalate: attempt, failureKind: attempt > 0 ? failureKind : undefined,
      reason: choice.reason, usage, costUSD: attemptCost, wallMs: Date.now() - started, checks: [], failures: [],
    };
    attempts.push(rec);

    if (failureMsg) {
      error = failureMsg;
      break; // a model/provider failure ends the turn (no failover hops headless — bench envs are healthy)
    }

    // Files the model changed via shell or a CLI seat don't emit file-change
    // events; the porcelain delta catches them.
    for (const f of gitDirty(cwd)) if (!baseline.has(f)) changedFiles.add(f);

    let failures: string[] = [];

    // ── Cascade drivers (first attempt only — after an escalation the strong
    // model's work is judged by the real verifier like any other turn).
    if (cascade && attempt === 0 && changedFiles.size && !opts.signal?.aborted) {
      const wantCheck = cascade === "draft-review" || verifierTier === "none"; // selfverify only where no real gate exists
      if (wantCheck) {
        const diff = gitDiffText(cwd);
        if (diff) {
          const isReview = cascade === "draft-review";
          const aux = await auxCompletion({
            selector,
            system: isReview ? REVIEW_SYSTEM : SELFCHECK_SYSTEM,
            prompt: `Task:\n${opts.prompt}\n\nDiff:\n${diff}`,
            kindHint: "classify",
            strong: isReview,
            onEvent,
          });
          if (aux) {
            const rejected = /^\s*(REJECT|FAIL)/i.test(aux.text);
            rec.aux = { role: isReview ? "review" : "self-check", model: aux.model, verdict: rejected ? "reject" : "pass", costUSD: aux.costUSD };
            totals.costUSD += aux.costUSD ?? 0;
            if (rejected) {
              const note = aux.text.replace(/^\s*(REJECT|FAIL)\s*:?\s*/i, "").trim() || "the draft does not accomplish the task";
              failures = [`${isReview ? "review" : "self-check"}: ${note}`];
              failureKind = "test"; // semantic miss → the escalation path treats it like a failed test
            }
          }
        }
      }
    }

    // ── Real verification (the gate). Skipped when the cascade already
    // rejected the draft — the rejection IS this attempt's failure.
    if (!failures.length && doVerify && changedFiles.size && !opts.signal?.aborted) {
      const cmds = detectVerificationCommands(cwd, [...changedFiles]);
      if (cmds.length) {
        const results = await runVerification(cmds, { onEvent, signal: opts.signal });
        rec.checks = cmds.slice(0, results.length).map((c) => c.command);
        failures = results
          .map((r, i) => ({ r, cmd: rec.checks[i] ?? "check" }))
          .filter((x) => !x.r.ok)
          .map((x) => `${x.cmd}: ${x.r.output.slice(0, 400)}`);
        if (failures.length) failureKind = worstFailureKind(failures);
        else proof = provenTier(rec.checks.map((c) => checkIntent(c) ?? undefined));
      }
    }
    rec.failures = failures.map((f) => f.slice(0, 200));

    // ── Flywheel: this attempt's outcome is ground truth for (kind, model).
    if (changedFiles.size) {
      const outcome = failures.length ? "failed" : doVerify && rec.checks.length ? "passed" : "unverified";
      const outcomeKind = kind ?? "code";
      try {
        recordTurnOutcome({ kind: outcomeKind, modelId: choice.model.id, outcome });
        recordRoutingOutcome({
          kind: outcomeKind, modelId: choice.model.id, outcome, prompt: opts.prompt,
          terms: terms(opts.prompt), touched: [...changedFiles], proofTier: verifierTier, policy,
        });
      } catch { /* bookkeeping never breaks the turn */ }
    }

    if (!failures.length || attempt >= maxAttempts || overCap() || opts.signal?.aborted) {
      if (failures.length) error = error ?? `still failing after ${attempt + 1} attempt${attempt ? "s" : ""}: ${failures[0]}`;
      break;
    }

    // ── Fix attempt setup. Mechanical failures under the fix-routing/combined
    // policies run with TRIMMED context: the compiler error names the exact
    // spot, so the cheap fixer gets the failure + the changed-file list, not
    // the whole conversation (50–80% cheaper fix iterations).
    const mechanical = failureKind === "typecheck" || failureKind === "lint" || failureKind === "build";
    const trims = (policy === "fix-routing" || policy === "combined") && mechanical;
    turnPrompt = buildFixPrompt(failures) + (trims ? `\n\nFiles changed so far: ${[...changedFiles].join(", ")}` : "");
    if (trims) history = [];
  }

  totals.wallMs = Date.now() - startedAll;
  return {
    ok: !error,
    text: text.trim(),
    policy,
    kind: resolvedKind,
    verifierTier,
    proofTier: proof,
    attempts,
    changedFiles: [...changedFiles],
    totals,
    error,
  };
}
