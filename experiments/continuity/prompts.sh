#!/usr/bin/env bash
# Build three handoff prompts to test, against a LIVE model, whether a curated
# projection is sufficient to continue a task, and whether fact-invalidation
# removes a poisoned lead. The continuing model never saw the full transcript.
set -e
D="$(cd "$(dirname "$0")" && pwd)"

HEAD='You are taking over an in-progress coding task from another agent (a different model). You never saw the earlier conversation — only this curated handoff. Answer in ONE sentence: what is the single next action you would take, and which file does it concern?'

# A) SUFFICIENCY — Gearbox curated handoff AFTER the fix (poison already invalidated, gone)
cat > "$D/A_sufficiency.txt" <<EOF
$HEAD

SYSTEM: Coding agent in a TypeScript repo; verify against test output.
TASK: Fix failing auth tests so an expired session returns null and requireSession redirects to /login.
KNOWN FACTS:
- auth.test.ts has 3 failing tests, all about expired sessions.
- parseToken returns exp in SECONDS (epoch), by design.
- Root bug: auth.ts compared token.exp (seconds) against Date.now() (ms); fixed by multiplying exp by 1000.
RECENT ACTIONS:
- Edited auth.ts:11 -> "token.exp * 1000 < Date.now()".
EOF

# B) POISON PRESENT — pre-fix point, the wrong early assumption still active
cat > "$D/B_poison.txt" <<EOF
$HEAD

SYSTEM: Coding agent in a TypeScript repo; verify against test output.
TASK: Fix failing auth tests so an expired session returns null and requireSession redirects to /login.
KNOWN FACTS:
- auth.test.ts has 3 failing tests, all about expired sessions.
- The bug is in parseToken — it must be returning a bad exp.
RECENT ACTIONS:
- Ran the tests; saw 3 expiry-related failures.
EOF

# C) POISON INVALIDATED — same point, the wrong assumption retracted by the ledger
cat > "$D/C_clean.txt" <<EOF
$HEAD

SYSTEM: Coding agent in a TypeScript repo; verify against test output.
TASK: Fix failing auth tests so an expired session returns null and requireSession redirects to /login.
KNOWN FACTS:
- auth.test.ts has 3 failing tests, all about expired sessions.
RECENT ACTIONS:
- Ran the tests; saw 3 expiry-related failures.
EOF

echo "wrote A_sufficiency.txt, B_poison.txt, C_clean.txt to $D"
