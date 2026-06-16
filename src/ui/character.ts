// Gearbox's character lives here: the working verb shown beside the elapsed
// clock while a turn runs. Calm and warm, never a pun or a gimmick — one plain
// word that reads as "the agent is thinking," not a themed mascot line. The
// concrete activity ("reading simulate.py") lives on the line below; this word
// is just a quiet, human sign of life.

// Single-word present participles. Plain phase words only: the status line must
// communicate what kind of work is happening, not a mascot mood.
export const WORKING_VERBS = [
  "Thinking",
  "Reasoning",
  "Planning",
  "Reading",
  "Checking",
  "Reviewing",
  "Tracing",
  "Editing",
  "Verifying",
  "Summarizing",
];

let last = -1;
/** A verb different from the previous one (so consecutive turns vary). */
export function nextVerb(): string {
  let i = Math.floor(Math.random() * WORKING_VERBS.length);
  if (i === last) i = (i + 1) % WORKING_VERBS.length;
  last = i;
  return WORKING_VERBS[i]!;
}

// Present-participle verb for the live status line, naming the tool ACTUALLY
// running right now (reading / editing / running …). Mirrors the friendly tool
// names in lines.ts and the write-like guard in App. Unknown tools fall back to a
// neutral "Working" rather than guessing. Pure.
export function toolVerbFromName(name: string): string {
  const n = name.toLowerCase();
  if (n === "read_file" || n === "read") return "Reading";
  if (n === "write_file" || n === "write" || n === "file_change") return "Writing";
  if (n === "edit_file" || n === "edit") return "Editing";
  if (n === "run_shell" || n === "command_execution" || n === "bash") return "Running";
  if (n === "list_dir" || n === "list_files" || n === "ls" || n === "list") return "Listing";
  if (n === "glob") return "Globbing";
  if (n === "search") return "Searching";
  if (n === "web_search" || n === "websearch") return "Searching the web";
  if (n === "webfetch") return "Fetching";
  if (n === "grep") return "Searching";
  if (n === "todowrite") return "Planning";
  if (n === "multiedit") return "Editing";
  if (n.startsWith("delegate") || n === "task" || n === "agent") return "Delegating";
  return "Working";
}

// Low-context notice for the live status line. Shown only when context is
// genuinely low (≤15% left, i.e. ctxPct ≥ 85). Returns null for a null ctxPct
// (no turn has reported usage yet) so nothing appears before a real figure exists.
export function lowContextNotice(ctxPct: number | null): string | null {
  if (ctxPct == null || ctxPct < 85) return null;
  const left = Math.max(0, 100 - ctxPct);
  return `${left}% context left · /compact to free space`;
}
