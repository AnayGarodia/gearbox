// Cascade policies — the two turn-shape approaches. Selection-wise both draft
// with the cheapest competent model; what differs is WHO verifies the draft,
// which lives in the cascade driver (src/agent/headless.ts) keyed off the
// selector's `cascade` marker:
//
//   selfverify   — AutoMix-style: a cheap LLM self-check judges the draft
//                  (for workspaces where no test verifier exists; the check is
//                  aux-billed like the classifier). Escalates on a NO verdict.
//   draft-review — speculative drafting: the STRONG model reviews the diff
//                  (review is mostly input tokens ≪ generation cost) and only
//                  takes over generation when it rejects the draft.
//
// On escalation (the draft was rejected or failed checks) both fall through to
// the baseline climb, so the strong model takes over through the normal path.
import { RoutingSelector } from "../router.ts";
import type { Task, ModelChoice } from "../selector.ts";
import { cheapestAbove } from "./util.ts";

// Haiku/Flash class and up may draft; below that, drafts waste the reviewer's time.
const DRAFT_FLOOR = 0.35;

export type CascadeKind = "selfverify" | "draft-review";

export class CascadeSelector extends RoutingSelector {
  override readonly policyName: string;

  constructor(readonly cascade: CascadeKind, fallbackId?: string) {
    super(fallbackId);
    this.policyName = cascade;
  }

  override select(task: Task): ModelChoice {
    if ((task.escalate ?? 0) > 0) return super.select(task); // rejected draft → baseline climb
    const p = this.prepare(task);
    if (!p.pool.length || (p.kind !== "code" && p.kind !== "plan")) return super.select(task);
    if (this.preferredIn(p.kind, p.pool)) return super.select(task);
    const inLoop = p.pool.filter((c) => c.backend.kind !== "cli"); // a seat is already ~free; cascading it saves nothing
    const cheap = cheapestAbove(inLoop, p.kind, DRAFT_FLOOR, p.estInputTokens);
    if (!cheap) return super.select(task);
    const how = this.cascade === "selfverify" ? "self-check verifies the draft" : "strong model reviews the diff";
    const choice: ModelChoice = { model: cheap.spec, reason: `${p.kind} · cheap draft (${how})`, backend: cheap.backend };
    this.logDecision(task, p.kind, p.bar, p.escalate, choice, inLoop, p);
    return choice;
  }
}
