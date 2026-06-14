// ask.ts — broker for the agent asking the USER clarifying questions.
//
// Mirrors permission.ts: the `ask_user` tool calls requestUserAnswer(), which
// blocks until the registered UI handler resolves the answers. Because the tool
// awaits this, the agent turn PAUSES on that tool call — nothing else runs until
// the user answers. That's the structural fix for "the agent asks then barrels
// on": asking is a tool that waits, not text it prints and ignores.
//
// Asking is ALWAYS safe, so unlike permission there is no yolo / grant / deny —
// it just routes to the UI (per-root for conductor tabs) and returns the answer.
// With no handler installed (headless / tests) it returns null, and the tool
// tells the model to proceed on best judgment — so it never hangs off-TTY.

export interface AskOption {
  label: string;
  description?: string;
}

export interface AskQuestion {
  question: string;
  /** When present, the user picks from these. Absent → free-text answer. */
  options?: AskOption[];
  /** Allow choosing more than one option. */
  multiSelect?: boolean;
}

export interface AskRequest {
  questions: AskQuestion[];
  /** Workspace root (conductor tabs route to the owning tab). */
  root?: string;
}

export interface AskAnswer {
  question: string;
  /** Selected option labels, or the typed free-text answer as a single entry. */
  answers: string[];
}

type Handler = (req: AskRequest) => Promise<AskAnswer[] | null>;

let handler: Handler | null = null;
const rootHandlers = new Map<string, Handler>();

export function setAskHandler(h: Handler | null): void {
  handler = h;
}

export function registerAskHandler(root: string, h: Handler | null): void {
  if (h) rootHandlers.set(root, h);
  else rootHandlers.delete(root);
}

/** Ask the user; resolves with their answers, or null if there's no UI to ask
 *  (headless) or they dismissed without answering. */
export async function requestUserAnswer(req: AskRequest): Promise<AskAnswer[] | null> {
  const route = (req.root && rootHandlers.get(req.root)) || handler;
  if (!route) return null;
  try {
    return await route(req);
  } catch {
    return null;
  }
}
