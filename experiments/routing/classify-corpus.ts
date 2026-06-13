// Labeled prompt corpus for the keyword task-judge (experiment T1 + the TDD
// fixture for the keyword classifier in src/model/router.ts).
//
// Each row is a realistic prompt a user might type, paired with the kind a GOOD
// judge should return. The guiding rule (the user can prompt LITERALLY anything):
// the safe failure direction is toward the HIGHER bar. A hard task misread as
// easy (code/plan → chat/summarize) routes real work to a weak model — that is
// the costly error. An easy task misread as hard just spends a little more. So
// every ambiguous/garbage row is labeled with the safe default the judge SHOULD
// produce, not the label a perfect oracle would assign.
//
// `floor: true` marks rows the keyword judge is NOT expected to nail on its own
// (genuinely ambiguous between two valid kinds) — for those we only require it
// NOT to land below the safe bar. The bench reports them separately and the test
// asserts only the safety property, never an exact kind.

export type Kind = "summarize" | "classify" | "search" | "chat" | "plan" | "code";

// Quality bar per kind, mirrored from router.ts BAR (kept local so the bench can
// score "dangerous vs wasteful" without importing router internals).
export const BAR: Record<Kind, number> = {
  summarize: 0,
  classify: 0,
  search: 0.2,
  chat: 0.3,
  plan: 0.7,
  code: 0.7,
};

export interface LabeledPrompt {
  prompt: string;
  expected: Kind;
  cat: string;
  /** True when the exact kind is genuinely ambiguous; the test only checks the
   *  bar is not undershot (no hard→cheap misroute), not the exact label. */
  floor?: boolean;
  note?: string;
}

export const CORPUS: LabeledPrompt[] = [
  // ── A. Clear code mutations → code ─────────────────────────────────────────
  { prompt: "fix the failing auth tests", expected: "code", cat: "mutation" },
  { prompt: "implement a debounce function", expected: "code", cat: "mutation" },
  { prompt: "refactor the user service into smaller modules", expected: "code", cat: "mutation" },
  { prompt: "add a --json flag to the export command", expected: "code", cat: "mutation" },
  { prompt: "rename getUser to fetchUser everywhere", expected: "code", cat: "mutation" },
  { prompt: "delete the deprecated v1 endpoints", expected: "code", cat: "mutation" },
  { prompt: "migrate the config from JSON to TOML", expected: "code", cat: "mutation" },
  { prompt: "patch the security hole in the upload handler", expected: "code", cat: "mutation" },
  { prompt: "add a dark mode toggle", expected: "code", cat: "mutation" },
  { prompt: "find and fix the auth bug", expected: "code", cat: "mutation" },
  { prompt: "is this a bug? fix it", expected: "code", cat: "mutation" },
  { prompt: "summarize and refactor this module", expected: "code", cat: "mutation", note: "mixed; refactor wins → strong tier" },
  { prompt: "can you refactor the loader?", expected: "code", cat: "mutation" },
  { prompt: "how do I fix this flaky test?", expected: "code", cat: "mutation" },

  // ── B. Real code work phrased WITHOUT a current mutation verb → code ────────
  // These rely on the safe default (non-question → code) OR an expanded verb set.
  { prompt: "write a function that parses ISO 8601 dates", expected: "code", cat: "mutation-implicit" },
  { prompt: "make the build pass", expected: "code", cat: "mutation-implicit" },
  { prompt: "get the integration tests green", expected: "code", cat: "mutation-implicit" },
  { prompt: "convert this class component to hooks", expected: "code", cat: "mutation-implicit" },
  { prompt: "support webp in the image loader", expected: "code", cat: "mutation-implicit" },
  { prompt: "wire up the new logout endpoint to the button", expected: "code", cat: "mutation-implicit" },
  { prompt: "optimize the slow dashboard query", expected: "code", cat: "mutation-implicit" },
  { prompt: "extract the validation into a shared helper", expected: "code", cat: "mutation-implicit" },
  { prompt: "the parser chokes on nested templates", expected: "code", cat: "mutation-implicit", note: "statement of a code defect" },

  // ── C. Debugging questions → code (NOT chat) ─ the key hole ─────────────────
  { prompt: "why is this throwing undefined?", expected: "code", cat: "debug" },
  { prompt: "why does the build fail?", expected: "code", cat: "debug" },
  { prompt: "what's causing this null pointer exception?", expected: "code", cat: "debug" },
  { prompt: "the app crashes on startup, any idea why?", expected: "code", cat: "debug" },
  { prompt: "this function returns the wrong value, what's wrong?", expected: "code", cat: "debug" },
  { prompt: "how come the request times out?", expected: "code", cat: "debug" },
  { prompt: "where is the memory leak coming from?", expected: "code", cat: "debug", note: "looks like search but is a debug trace" },
  { prompt: "the tests pass locally but fail in CI, why?", expected: "code", cat: "debug" },
  { prompt: "TypeError: cannot read properties of undefined (reading 'map') — what do I do?", expected: "code", cat: "debug", note: "pasted error" },
  { prompt: "Traceback (most recent call last): KeyError: 'id'. any idea?", expected: "code", cat: "debug", note: "pasted stack trace, no fix verb" },
  { prompt: "my regex matches too much, what went wrong?", expected: "code", cat: "debug" },

  // ── D. Design / planning → plan (NOT chat) ─ the other key hole ─────────────
  { prompt: "how should we split this service before adding multi-tenancy?", expected: "plan", cat: "plan" },
  { prompt: "what's the best way to structure the auth module?", expected: "plan", cat: "plan" },
  { prompt: "should I use a queue or a cron job for this?", expected: "plan", cat: "plan" },
  { prompt: "how would you architect the caching layer?", expected: "plan", cat: "plan" },
  { prompt: "what's the tradeoff between optimistic and pessimistic locking here?", expected: "plan", cat: "plan" },
  { prompt: "plan out the migration from REST to GraphQL", expected: "plan", cat: "plan" },
  { prompt: "what's a good approach to rate limiting this API?", expected: "plan", cat: "plan" },
  { prompt: "design an approach for offline sync", expected: "plan", cat: "plan" },

  // ── E. Genuine concept questions → chat ─ must stay cheap ───────────────────
  { prompt: "what does this regex match?", expected: "chat", cat: "concept" },
  { prompt: "what is a closure?", expected: "chat", cat: "concept" },
  { prompt: "explain the difference between let and const", expected: "chat", cat: "concept" },
  { prompt: "what does the spread operator do?", expected: "chat", cat: "concept" },
  { prompt: "how does the event loop work?", expected: "chat", cat: "concept" },
  { prompt: "is bun faster than node?", expected: "chat", cat: "concept" },
  { prompt: "does typescript erase enums at runtime", expected: "chat", cat: "concept" },
  { prompt: "what is the time complexity of quicksort?", expected: "chat", cat: "concept" },
  { prompt: "What is capital of India", expected: "chat", cat: "concept", note: "off-topic, still chat" },

  // ── F. Greetings / acknowledgements → chat ──────────────────────────────────
  { prompt: "hi", expected: "chat", cat: "greeting" },
  { prompt: "thanks!", expected: "chat", cat: "greeting" },
  { prompt: "ok cool", expected: "chat", cat: "greeting" },
  { prompt: "good morning", expected: "chat", cat: "greeting" },

  // ── G. Summarize → summarize (incl. adversarial collisions) ─────────────────
  { prompt: "tl;dr this error log", expected: "summarize", cat: "summarize" },
  { prompt: "summarize this RFC for me", expected: "summarize", cat: "summarize" },
  { prompt: "give me a recap of the discussion above", expected: "summarize", cat: "summarize" },
  { prompt: "tl;dr of the above", expected: "summarize", cat: "summarize" },
  { prompt: "summarize the test output", expected: "summarize", cat: "summarize", note: "must NOT become code (no 'test'/'build' in mutation set)" },
  { prompt: "summarize this paragraph for me", expected: "summarize", cat: "summarize" },

  // ── H. Classify → classify ──────────────────────────────────────────────────
  { prompt: "is this function pure? yes or no", expected: "classify", cat: "classify" },
  { prompt: "label this commit as feat, fix, or chore", expected: "classify", cat: "classify", floor: true, note: "contains the mutation word 'fix' as data — genuinely ambiguous for keywords, should escalate to the LLM" },
  { prompt: "classify this error as transient or fatal", expected: "classify", cat: "classify" },
  { prompt: "categorize these log lines", expected: "classify", cat: "classify" },
  { prompt: "what's the sentiment of this review?", expected: "classify", cat: "classify" },

  // ── I. Search → search ──────────────────────────────────────────────────────
  { prompt: "where is the retry logic defined?", expected: "search", cat: "search" },
  { prompt: "find the file that handles auth", expected: "search", cat: "search" },
  { prompt: "locate the config loader", expected: "search", cat: "search" },
  { prompt: "which file defines the User type?", expected: "search", cat: "search" },
  { prompt: "grep for usages of deprecatedFn", expected: "search", cat: "search" },
  { prompt: "where is the model chosen", expected: "search", cat: "search" },

  // ── J. Mixed: read-the-workspace-then-summarize → code (needs to drive tools)
  { prompt: "read the files and summarize them", expected: "code", cat: "mixed", floor: true, note: "must NOT be cheap summarize; driving tools needs a capable model" },
  { prompt: "go through the repo and give me a summary, tl;dr", expected: "code", cat: "mixed", floor: true },
  { prompt: "summarize the codebase", expected: "code", cat: "mixed", floor: true },

  // ── K. Messy / anything → safe default (code) ───────────────────────────────
  { prompt: "the thing is broken pls help", expected: "code", cat: "messy", floor: true, note: "debug-ish, route safe" },
  { prompt: "make it better", expected: "code", cat: "messy", floor: true },
  { prompt: "asdkfjghts", expected: "code", cat: "messy", floor: true, note: "gibberish → safe default" },
  { prompt: "do the needful", expected: "code", cat: "messy", floor: true },
];
