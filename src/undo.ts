// Per-turn file-change snapshots → /undo and /diff. Pure: the App collects
// `file-change` events into a turn's change list (recordChange), and /undo turns
// that list into filesystem actions (planUndo). The first before-state seen per
// path in a turn is the pre-turn content, so undo restores the whole turn at once.

export interface FileChange {
  path: string; // workspace-relative
  before: string; // file content before this turn touched it ("" if it didn't exist)
  existed: boolean; // did the file exist before this turn
}

export type UndoAction = { path: string; action: "delete" } | { path: string; action: "restore"; content: string };

/** Fold a single change into the turn's list, keeping the EARLIEST before per path
 *  (so repeated edits in one turn still undo to the pre-turn state). */
export function recordChange(turn: FileChange[], change: FileChange): FileChange[] {
  if (turn.some((c) => c.path === change.path)) return turn; // already captured pre-turn state
  return [...turn, change];
}

/** Turn a captured turn into the filesystem actions that reverse it. */
export function planUndo(changes: FileChange[]): UndoAction[] {
  return changes.map((c) => (c.existed ? { path: c.path, action: "restore", content: c.before } : { path: c.path, action: "delete" }));
}
