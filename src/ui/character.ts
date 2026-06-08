// Gearbox's character lives here: workshop-themed working verbs (shown beside
// Boo while it works). Restrained but warm · the personality is in the words.

// Present-participle, mechanical/gearbox-themed. Grin-worthy, never cutesy.
export const WORKING_VERBS = [
  "Shifting gears",
  "Torquing bolts",
  "Routing power",
  "Calibrating",
  "Meshing the cogs",
  "Revving up",
  "Greasing the rails",
  "Spinning up",
  "Downshifting",
  "Finding traction",
  "Winding the mainspring",
  "Tuning the timing",
  "Building torque",
  "Throwing sparks",
  "Oiling the chain",
  "Engaging the clutch",
  "Checking tolerances",
  "Warming the engine",
  "Aligning the teeth",
  "Priming the pump",
  "Cranking",
  "Adjusting the timing belt",
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
  if (n === "web_search") return "Searching the web";
  if (n.startsWith("delegate")) return "Delegating";
  return "Working";
}

// The low-context notice for the live status line. Shown ONLY when the context is
// genuinely low (≤15% of the window left ⇒ ctxPct ≥ 85), in amber, with the fix
// command. Returns null otherwise — including a null ctxPct (no turn has reported
// usage yet) — so nothing appears unless the figure is real, never fabricated.
export function lowContextNotice(ctxPct: number | null): string | null {
  if (ctxPct == null || ctxPct < 85) return null;
  const left = Math.max(0, 100 - ctxPct);
  return `${left}% context left · /compact to free space`;
}
