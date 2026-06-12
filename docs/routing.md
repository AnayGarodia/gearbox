# Model routing

The point of Gearbox: every turn, pick the cheapest (model, account) pair that
clears the quality bar for this task — and learn from what actually happens in
your repo.

## What happens on a turn

1. **Classify** — a keyword fast-path (cheap-LLM fallback) labels the task kind
   (code, edit, summarize, search, …).
2. **Quality bar** — models below the bar for that kind are dropped. The bar
   uses benchmark-seeded quality (`~` in /why) ADJUSTED by what has been
   measured in this repo: every verified turn outcome (tests passed/failed,
   /undo) feeds a per-(kind, model) prior. A model that keeps failing
   verification *here* sinks below the bar *here*.
3. **Context fit** — the conversation must fit the model's window.
4. **Score** — `cost + scarcity + switch penalty + limit penalty + throttle − plan bonus`,
   per (model, account) pair. A subscription seat is ~$0 marginal, so it wins
   until its rate window fills; declared budgets make scarce credit expensive.
5. **Cheapest winner.** Deterministic tie-break. `/why` shows every candidate
   and the verdict in plain words.

## Steering it

```
/why                      the full scorecard for the last pick
/prefer <kind> <model>    remember a preference for a task type
/model <name>             hard pin (beats routing) · /model auto to unpin
/account use <name>       pin an account/seat
/effort <level>           reasoning effort, clamped to the model's vocabulary
/budget <provider> <amt>  declared balance → scarcity signal
/cap session|daily 5      hard ceiling: turns refuse at the cap
```

## Failover

A turn that fails with a rate/credit/auth error before any output streamed is
re-routed: the failed pair is parked on a scoped cooldown (rate/quota parks the
(account, model) pair; billing/auth parks the account) and the selector picks
again — possibly a different provider — up to 2 hops, narrated in the
transcript. Real errors never hop.

## What it learns, where it lives

- Per-repo priors: `~/.gearbox/priors.json` (silent under 4 verified outcomes;
  conservative and asymmetric — failure counts more than success).
- Preferences: `~/.gearbox/routing-preferences.json` (/prefer).
- Spend, balances, rate headroom: `~/.gearbox/usage.json` + `ledger.jsonl`,
  read on-turn from disk — routing never blocks on the network.
