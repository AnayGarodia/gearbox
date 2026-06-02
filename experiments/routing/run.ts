import { MODELS, BALANCES, type Model } from "./models.ts";
import { buildTasks } from "./tasks.ts";
import { costFor, routeCheapestAdequate, routeGearbox, explain } from "./router.ts";

const tasks = buildTasks(100);
const get = (id: string) => MODELS.find((m) => m.id === id)!;

type Strat = { name: string; pick: (t: any, bal: Record<string, number>) => Model };
const strategies: Strat[] = [
  { name: "always-opus", pick: () => get("claude-opus-4-8") },
  { name: "always-flash-lite", pick: () => get("gemini-3.1-flash-lite") },
  { name: "cheapest-adequate (credit-blind)", pick: (t) => routeCheapestAdequate(t) },
  { name: "Gearbox (marginal-benefit + credit)", pick: (t, bal) => routeGearbox(t, bal).model },
];

console.log("EXPERIMENT 2 — intelligent routing vs naive baselines (100 tasks, 70/20/10 mix)\n");
console.log("strategy                              total$    success%   anthropic$  openai$  google$  deepseek$  overspent?");
for (const s of strategies) {
  const bal = { ...BALANCES };
  const spend: Record<string, number> = { anthropic: 0, openai: 0, google: 0, deepseek: 0 };
  let success = 0, total = 0, overspent = false;
  for (const t of tasks) {
    const m = s.pick(t, bal);
    const c = costFor(m, t);
    bal[m.provider] -= c;
    spend[m.provider] += c;
    if (bal[m.provider] < 0) overspent = true;
    if (m.quality[t.type] >= t.req) success++;
    total += c;
  }
  console.log(
    `${s.name.padEnd(38)}$${total.toFixed(3).padStart(7)}   ${((success / tasks.length) * 100).toFixed(0).padStart(5)}%    ` +
      `$${spend.anthropic.toFixed(2).padStart(8)} $${spend.openai.toFixed(2).padStart(6)} $${spend.google.toFixed(2).padStart(6)} $${spend.deepseek.toFixed(2).padStart(7)}    ${overspent ? "YES ⚠️" : "no"}`,
  );
}

// routing breakdown for Gearbox
console.log("\nGearbox routing breakdown (which model won, by task type):");
const bal2 = { ...BALANCES };
const byType: Record<string, Record<string, number>> = {};
for (const t of tasks) {
  const { model } = routeGearbox(t, bal2);
  bal2[model.provider] -= costFor(model, t);
  byType[t.type] ??= {};
  byType[t.type][model.id] = (byType[t.type][model.id] || 0) + 1;
}
for (const [type, counts] of Object.entries(byType))
  console.log(`  ${type.padEnd(13)} → ${Object.entries(counts).map(([m, n]) => `${m}×${n}`).join(", ")}`);

// transparency: marginal-benefit on one hard task
console.log("\nTransparency — an architecture task (req=0.92), scored (lower score = better):");
const hard = tasks.find((t) => t.type === "architecture")!;
for (const r of explain(hard, BALANCES))
  console.log(
    `  ${r.id.padEnd(22)} q=${r.q.toFixed(2)} ${r.clears ? "clears" : "FAILS "} cost=$${r.cost.toFixed(3)} bal=$${String(r.balance).padStart(5)} score=${r.score.toFixed(3)}`,
  );
const blind = routeCheapestAdequate(hard);
const smart = routeGearbox(hard, BALANCES).model;
console.log(`\n  credit-blind picks: ${blind.id} (cheapest that clears the bar — but spends scarce OpenAI credit)`);
console.log(`  Gearbox picks:      ${smart.id} (clears the bar, draws on the flush account — preserves OpenAI)`);
console.log(`  marginal-benefit:   Opus clears at q=0.97 but Sonnet already clears at 0.93 ⇒ paying for Opus buys 0.04 above the bar = wasted.`);
