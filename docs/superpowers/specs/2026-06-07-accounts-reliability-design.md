# Accounts reliability — design

Date: 2026-06-07
Status: approved (design); implementation plan pending

## Problem

Gearbox is meant to use every subscription, API key, and cloud credential the
user owns, all the time. Today it doesn't:

- Switching between two Claude (or two ChatGPT) subscription accounts can fail
  with a raw "expired"/auth error. There's no detection, no clear message, and
  no easy re-login.
- The agent loop uses exactly one default account per provider. If that key is
  rate-limited, out of credit, or dead, the turn fails instead of using another
  account the user owns.
- Account numbers are array positions (`listAccounts()[n-1]`). Removing an
  account shifts every number below it, so `/account 3` silently lands on a
  different account than it did yesterday.
- Credential ingestion is uneven: paste-detection knows only a few key
  prefixes, and Bedrock/Vertex/Azure "tests" only check that fields are present.

## Goals

1. **Failover** — a turn uses the next healthy credential automatically when one
   fails, across providers that serve the same model. "Works all the time."
2. **Clarity** — every failure says exactly what's wrong and the single next
   action. An expired subscription offers one-step re-login.
3. **Stable identity** — accounts are referenced by name; references never break
   when other accounts are added or removed.
4. **Universal ingestion** — paste any credential (key, AWS block, service-account
   JSON, Azure endpoint, gateway key) and Gearbox identifies it, fills the gaps,
   tests it, and records its health.

## Non-goals (this pass)

- Background polling of account health (explicitly rejected — checks are
  event-driven only).
- Credit/balance-aware ranking beyond health + user order (the richer cost
  engine layers on later, reading the same health/usage data).
- Token extraction from subscription binaries (never — CLI accounts always run
  via the vendor binary).

## Decisions (locked with the user)

- **Failover policy:** auto-failover, then tell the user which account was used.
- **Failover unit:** keyed by **model, not provider** — failover for "Claude
  Sonnet" may span Anthropic API → Bedrock → Vertex → Claude subscription.
- **Health checks:** event-driven (boot, opening `/account`, on switch, on live
  failure), cached with a short TTL. No background polling.
- **Identity:** names/slugs only. Numeric switching is removed.
- **Re-login:** expired subscriptions must offer an easy, prominent re-login.

## Architecture

The routing seam (`ModelSelector`) is untouched. This work lives entirely in the
**account resolution + execution** layer that sits between the selector's model
choice and the provider SDK call.

### 1. Account pools + failover (the reliability engine)

`AccountResolver` changes from "pick the one default" to **rank a pool**:

```
rank(model) → Account[]   // best-first
```

Candidates = every enabled account that can serve `model` (an Anthropic key, a
Bedrock account, a Vertex account, and a Claude subscription can all be
candidates for a Claude model). Ordering: healthy > unknown > unhealthy, then the
user's explicit order. `pick(provider)` is kept as a thin wrapper
(`rank(...)[0]`-style) for callers that still want a single account.

The agent run wraps streaming in a failover loop:

```
candidates = resolver.rank(model)
for acct in candidates:
    creds = resolveCreds(acct)
    try:
        stream(acct, creds)
        recordHealth(acct, "ok")
        markUsed(acct); break
    catch e:
        state = classifyError(acct.provider, e)
        if state is credential-class:               // expired/invalid/no-credit/rate-limited
            recordHealth(acct, state)
            emit phase: "{acct} {state} → using {next}"
            continue
        else:
            rethrow                                  // network/tool/model bug: do NOT burn the pool
all candidates failed → one consolidated, actionable error listing each account
and why it failed, plus the fix for each (re-login / replace key / add credit).
```

Only credential-class failures advance the pool. A genuine network or model
error is re-thrown so the loop doesn't churn through every account on a transient
blip.

Same-provider multiple keys (two Anthropic keys, etc.) are just multiple
candidates in the pool — rotation on rate-limit/credit falls out of the same
mechanism.

CLI subscription accounts participate too: if the active subscription's call
fails because the login expired, the loop classifies it as `expired`, fails over
to the next candidate (another subscription or an API key serving the model), and
the expired account is flagged with a one-step re-login affordance (below).

### 2. Health — event-driven, cached

New module `src/accounts/health.ts`:

- `type HealthState = "ok" | "expired" | "invalid" | "no-credit" | "rate-limited" | "unknown"`
- `interface AccountHealth { state: HealthState; checkedAt: number; detail?: string }`
- `classifyError(provider: string, error: unknown): HealthState` — **pure, tested.**
  Maps provider error bodies / HTTP status / CLI exit + output to a state:
  - 401 / "invalid x-api-key" / "invalid_api_key" → `invalid`
  - "expired" / token refresh failure / CLI "not logged in" → `expired`
  - 429 / "rate limit" / "overloaded" → `rate-limited`
  - "credit balance too low" / "insufficient_quota" / "billing" → `no-credit`
  - anything not credential-class → returns a sentinel the loop treats as
    "real error, do not failover"
- `checkHealth(account): Promise<AccountHealth>` — the live probe. Reuses
  `testAccount`-style cheap calls (token-count for Anthropic, model list for
  OpenAI-compat, `claude auth status` / `codex login status` for CLI).
- Health cache persisted in the registry (per account) with a short TTL
  (e.g. 5 min); `checkHealth` skips the network if a fresh entry exists.

Refresh touchpoints:
- **boot:** parallel sweep of all accounts, non-blocking; the status line / first
  `/account` reflects results as they land.
- **opening `/account`:** refresh (already does CLI checks; extend to all).
- **on switch:** validate the target before committing the switch.
- **on live failure:** the failover loop records state from `classifyError`.

### 3. Identity — names only, no numbers

- A stable, unique **slug** per account is the canonical reference
  (`claude`, `claude-work`, `anthropic-2`). Slugs are derived on add and
  guaranteed unique (suffix `-2`, `-3` on collision).
- `/account <slug>` switches; fuzzy matching (`findAccountRef`) handles partials.
- Numeric switching is removed from the `/account` parser, from
  `formatAccounts`, and from `buildAccountView`/`AccountRow`.
- The list shows: slug, label, type (subscription / API key), and a **health
  badge** — `✓ ready · ⚠ expired · ✗ invalid · ⏳ limited · — unknown` — plus the
  exact switch/fix command per row.
- `accountBySlug(slug)` added to the store.

### 4. Universal ingestion ("throw anything at it")

New module `src/accounts/sniff.ts`:

- `sniffCredential(text: string): CredentialGuess` — **pure, tested.**
- `interface CredentialGuess { kind: AuthKind | "aws-block" | "unknown"; provider?: string; fields: Record<string,string>; missing: string[]; confidence: "high"|"low" }`

Recognizes:
- API-key prefixes: `sk-ant-` (anthropic), `sk-proj-`/`sk-` (openai),
  `AIza` (google), `sk-or-` (openrouter), DeepSeek/xAI/Groq, etc.
- `AKIA…`/`ASIA…` access key, or a pasted block containing
  `aws_access_key_id=` / `aws_secret_access_key=` → AWS (Bedrock).
- New **Bedrock long-lived API keys** (bearer token) → bedrock.
- JSON beginning `{"type":"service_account"` → Vertex (project/location prompted
  or read from the JSON).
- A `*.openai.azure.com` or Azure AI Foundry endpoint URL → Azure (key prompted).
- Vercel **AI Gateway** key (`vck_…`) → openai-compat at the gateway base URL.
- Otherwise → `unknown`, guided fill (ask provider, base URL, key).

`/account add <paste>` and the bare guided `/account add` both route through the
sniffer. Missing fields are collected interactively; on completion the account is
created, **live-tested**, and its health recorded. `testAccount` gains real
connectivity checks for Bedrock / Vertex / Azure rather than field-presence only.

### 5. Clear failures + easy re-login

- Every credential failure renders with: what failed, why (the provider's own
  error text where available), and the one command to fix it.
- **Expired subscription** is the priority case: the failure surfaces a
  prominent, one-step re-login (run the vendor login flow inline for that
  account's profile dir, e.g. `/account login <slug>` or a single keypress), so
  the user is never left reading a raw stack trace.
- After a successful failover the UI shows a quiet phase line naming the account
  that actually ran and the one that was skipped (and why), so behavior is never
  silent-magic.

## Module changes

| File | Change |
|---|---|
| `accounts/health.ts` | **new** — `HealthState`, `AccountHealth`, `classifyError` (pure), `checkHealth`, cache |
| `accounts/sniff.ts` | **new** — `sniffCredential` (pure) |
| `accounts/resolve.ts` | `rank(model) → Account[]`; `pick` becomes the head of `rank`; model→accounts mapping |
| `accounts/store.ts` | unique slugs, health fields on `Account`, `accountBySlug`, drop number semantics |
| `accounts/onboard.ts` | adds route through `sniffCredential`; expand `testAccount` (Bedrock/Vertex/Azure live) |
| `accounts/types.ts` | add `health?: AccountHealth`; (slug already derivable) |
| `agent/run.ts` | wrap streaming in the failover loop; record health on success/failure |
| `agent/cli-backend.ts` | classify CLI expiry → failover + re-login affordance |
| `ui/App.tsx` | `/account` parser drops numbers; boot health sweep; failover/re-login surfacing |
| `ui/types.ts` | `AccountRow` drops `number`, gains health badge fields |
| `commands.ts` | `formatAccounts`/`buildAccountView` drop numbers, show badges + per-row fix command |

## Testing

- `classifyError` — table test across provider error shapes (401, 429, credit,
  CLI not-logged-in, transient) → expected states (pure).
- `sniffCredential` — table test across real-shaped samples per provider →
  expected `{kind, provider, missing}` (pure).
- `rank` — given a pool with mixed health, returns correct best-first order;
  cross-provider candidates for one model (pure given injected health).
- Failover loop — mock a candidate that throws a credential-class error and
  assert the next candidate runs and health is recorded (uses the existing mock
  backend pattern; no API keys).
- Slug uniqueness — adding two accounts that slugify the same yields distinct
  slugs.

## Open risks

- Detecting "this account can serve model X" across providers needs a
  model→providers map; reuse `profiles.ts` / `providers.ts` data rather than a
  new corpus.
- Cross-provider failover must respect exec mode: an in-loop turn can't silently
  fail over to a CLI subscription mid-stream (different execution path). v1: CLI
  accounts are candidates only at turn start, not as mid-stream fallbacks; an
  in-loop credential failure fails over among in-loop candidates first.
