// Hard spend caps with pre-flight enforcement. The existing BudgetConfig
// (preferences.ts) is a *balance estimator* that biases routing; this is a hard
// ceiling that REFUSES a turn once spend reaches it. Pure + tested; the caller
// supplies the live spend snapshot and an optional estimate of the pending turn.
//
// Caps matter more now that parallel fan-out can multiply spend in one sitting.

export interface BudgetCaps {
  session?: number; // USD cap for the current session
  daily?: number; // USD cap for the calendar day
  monthly?: number; // USD cap for the calendar month
  total?: number; // USD cap on lifetime tracked spend
}

export interface SpendSnapshot {
  session: number;
  daily: number;
  total: number;
  monthly: number;
}

export interface CapVerdict {
  allowed: boolean;
  hit?: keyof BudgetCaps;
  spent?: number;
  cap?: number;
  message?: string;
}

const LABEL: Record<keyof BudgetCaps, string> = {
  session: "session",
  daily: "today's",
  monthly: "this month's",
  total: "total",
};

const usd = (n: number) => "$" + n.toFixed(2);

// Most-binding first: a session cap is the tightest, then day, month, lifetime.
const ORDER: (keyof BudgetCaps)[] = ["session", "daily", "monthly", "total"];

export function checkCaps(caps: BudgetCaps, spend: SpendSnapshot, pendingUSD = 0): CapVerdict {
  for (const p of ORDER) {
    const cap = caps[p];
    if (cap == null) continue;
    const spent = spend[p];
    if (spent + pendingUSD >= cap) {
      return {
        allowed: false,
        hit: p,
        spent,
        cap,
        message: `${LABEL[p]} spend ${usd(spent)}${pendingUSD ? ` (+~${usd(pendingUSD)} for this turn)` : ""} would reach the ${usd(cap)} cap — raise it with /cap ${p} <amount>, or /cap off`,
      };
    }
  }
  return { allowed: true };
}
