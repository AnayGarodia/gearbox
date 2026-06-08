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
    if (it.kind === "phase") continue; // live-only; irrelevant once settled
    if (it.kind === "tool") {
      const name = it.name;
      if (EPHEMERAL_TOOLS.has(name)) continue; // context-gathering; noise once settled
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
      kept.push({ item: it }); // read / write / edit / non-check shell: keep verbatim
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
    kept.push({ item: it }); // user / assistant / error / model / summary / preference
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
  return collapseDelegateGroups(out);
}

// Once a delegate_parallel batch has SETTLED, fold its per-task child tool items
// into the group item and mark it collapsed — so a finished 5-task block renders
// as ONE summary row ("delegate_parallel · 5 done · 31 merged · ~18min") that the
// transcript expands (⌃O) to show the children. The live, mid-run view stays
// detailed; this is the transient→durable transition. Child ids are
// "<groupCallId>:<idx>" (set in delegate.ts), so they fold by callId prefix.
export function collapseDelegateGroups(items: Item[]): Item[] {
  const groups = new Set<string>();
  for (const it of items) {
    if (it.kind === "tool" && it.name === "delegate_parallel" && (it.status === "ok" || it.status === "err")) groups.add(it.callId);
  }
  if (!groups.size) return items;
  const childrenByGroup = new Map<string, Item[]>();
  const rest: Item[] = [];
  for (const it of items) {
    if (it.kind === "tool" && it.name === "delegate" && it.callId.includes(":")) {
      const parent = it.callId.slice(0, it.callId.indexOf(":"));
      if (groups.has(parent)) {
        childrenByGroup.set(parent, [...(childrenByGroup.get(parent) ?? []), it]);
        continue; // child folds into its group; don't emit it standalone
      }
    }
    rest.push(it);
  }
  return rest.map((it) =>
    it.kind === "tool" && groups.has(it.callId)
      ? { ...it, collapsed: true as const, children: childrenByGroup.get(it.callId) ?? [] }
      : it,
  );
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
  // Subsequent attempt: later state and summary win; durations accumulate.
  existing.attempts += 1;
  existing.ok = attempt.ok;
  existing.durationMs += attempt.durationMs;
  existing.command = attempt.command;
  existing.summary = attempt.summary;
  existing.output = attempt.output;
}

// A short phrase describing how a check fared across its attempts:
//   1 attempt        → ""              (the state line already says passed/failed)
//   passed on retry  → "retried once" / "retried 2 times"
//   still failing    → "failed after N attempts"
// "retried N" is used instead of "failed N times, retried" because the latter
// reads as a failure at a glance even when the check is green.
export function retryPhrase(ok: boolean, attempts: number): string {
  if (attempts <= 1) return "";
  const fails = ok ? attempts - 1 : attempts;
  const n = fails === 1 ? "once" : `${fails} times`;
  return ok ? `retried ${n}` : `failed after ${attempts} attempts`;
}
