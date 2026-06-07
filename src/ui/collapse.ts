// Collapse a turn's live trace into a durable record.
//
// While a turn runs, the transcript shows live spinners: phases (building
// context, contacting model, running command), context-gathering reads (list,
// glob, search), and every attempt of a check. The moment the turn settles those
// should be replaced by the facts that still matter: the files read/edited, and
// ONE line per check naming its final state. This is that transform — pure, so it
// is unit-tested and applied once in App's turn-settle path.
import type { Item } from "./types.ts";
import { checkIntent } from "../verify.ts";

// Tool names that are context-gathering — useful live, noise once settled.
const EPHEMERAL_TOOLS = new Set(["list_dir", "glob", "search", "list_files", "ls", "list", "web_search"]);

function isShellName(name: string): boolean {
  return name === "run_shell" || name === "command_execution" || name === "Bash";
}

interface CheckAgg {
  intent: string;
  command: string; // last literal command seen
  ok: boolean; // final state
  attempts: number;
  durationMs: number; // summed where known
  summary: string; // last attempt's summary
  output: string; // last attempt's output
  firstIndex: number; // where to emit the collapsed line
}

/**
 * Collapse one turn's items. Drops phases and context-gathering reads; folds the
 * repeated runs of each check (the agent's run_shell + the post-turn verifier)
 * into a single `verification` item carrying final state, attempt count, and
 * total duration. Keeps user / assistant / error / read / write / edit untouched.
 */
export function collapseTurn(items: Item[], nextId: () => number): Item[] {
  const aggs = new Map<string, CheckAgg>();
  const kept: ({ item: Item } | { checkKey: string })[] = [];

  for (const it of items) {
    if (it.kind === "phase") continue; // live spinner — gone once settled
    if (it.kind === "tool") {
      const name = it.name;
      if (EPHEMERAL_TOOLS.has(name)) continue; // context-gathering noise
      if (isShellName(name)) {
        const intent = checkIntent(it.arg);
        if (intent) {
          fold(aggs, kept, intent, {
            command: it.arg,
            ok: it.status !== "err",
            durationMs: it.durationMs ?? 0,
            summary: it.summary,
            output: it.outputTail ?? "",
          });
          continue;
        }
      }
      kept.push({ item: it }); // read / write / edit / non-check shell stay verbatim
      continue;
    }
    if (it.kind === "verification") {
      const intent = it.intent ?? checkIntent(it.command) ?? it.command;
      fold(aggs, kept, intent, {
        command: it.command,
        ok: it.ok,
        durationMs: it.durationMs ?? 0,
        summary: it.summary,
        output: it.output ?? "",
      });
      continue;
    }
    kept.push({ item: it }); // assistant / user / error / model / summary / preference …
  }

  const out: Item[] = [];
  for (const slot of kept) {
    if ("item" in slot) {
      out.push(slot.item);
    } else {
      const a = aggs.get(slot.checkKey)!;
      out.push({
        kind: "verification",
        id: nextId(),
        command: a.command,
        ok: a.ok,
        summary: a.summary,
        intent: a.intent,
        attempts: a.attempts,
        durationMs: a.durationMs || undefined,
        output: a.output || undefined,
      });
    }
  }
  return out;
}

function fold(
  aggs: Map<string, CheckAgg>,
  kept: ({ item: Item } | { checkKey: string })[],
  intent: string,
  attempt: { command: string; ok: boolean; durationMs: number; summary: string; output: string },
): void {
  const existing = aggs.get(intent);
  if (!existing) {
    aggs.set(intent, {
      intent,
      command: attempt.command,
      ok: attempt.ok,
      attempts: 1,
      durationMs: attempt.durationMs,
      summary: attempt.summary,
      output: attempt.output,
      firstIndex: kept.length,
    });
    kept.push({ checkKey: intent }); // placeholder; filled in second pass
    return;
  }
  // Subsequent attempt: final state + last summary/output win; durations sum.
  existing.attempts += 1;
  existing.ok = attempt.ok;
  existing.durationMs += attempt.durationMs;
  existing.command = attempt.command;
  existing.summary = attempt.summary;
  existing.output = attempt.output;
}

// A short phrase describing how a check fared across its attempts:
//   1 attempt           → ""           (the state line already says passed/failed)
//   passed after fails  → "failed once, retried" / "failed 2 times, retried"
//   still failing       → "after N attempts"
export function retryPhrase(ok: boolean, attempts: number): string {
  if (attempts <= 1) return "";
  const fails = ok ? attempts - 1 : attempts;
  const n = fails === 1 ? "once" : `${fails} times`;
  // Passed-on-retry reads calmer as "retried N" than "failed N times, retried"
  // (the latter looks like a failure at a glance even though the check is green).
  return ok ? `retried ${n}` : `failed after ${attempts} attempts`;
}
