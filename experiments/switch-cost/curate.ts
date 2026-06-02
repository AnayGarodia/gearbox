// Curation = projecting the full ledger into a small, portable context for a
// task-boundary switch. This is what the new provider ingests cold. The bet:
// it's tiny next to the raw transcript, so a cold cache is cheap and expected.
//
// What survives curation:
//   - system + tools (needed to operate)
//   - openTask (what we're doing)
//   - VALID facts only (invalidated/poisoned facts are dropped here — the
//     context-poisoning recovery mechanism, for free)
//   - the last K turns verbatim (continuity)
// What's dropped:
//   - bulky historical tool results (their distilled conclusion lives in facts)
//   - thinking blocks
//   - old chatter

import type { CanonicalState, Turn } from "./canonical.ts";

export function curate(s: CanonicalState, keepLastTurns = 3): CanonicalState {
  const validFacts = s.facts.filter((f) => f.valid);
  const recap =
    `CONTEXT RECAP (curated from ledger)\n` +
    `Task: ${s.openTask}\n` +
    `Known facts:\n` +
    validFacts.map((f) => `- ${f.text} (src: ${f.provenance})`).join("\n");

  const tail = s.turns.slice(-keepLastTurns).filter((t) => t.kind !== "thinking");

  const turns: Turn[] = [{ kind: "user_text", text: recap }, ...tail];
  return { system: s.system, tools: s.tools, facts: validFacts, openTask: s.openTask, turns };
}
