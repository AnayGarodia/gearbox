// Gearbox's character lives here: workshop-themed working verbs (shown beside
// Boo while it works). Restrained but warm — the personality is in the words.

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
