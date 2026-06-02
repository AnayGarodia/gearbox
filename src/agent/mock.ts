// Scripted demo runner: emits the same AgentEvents the real loop does, with no
// API key. Lets the TUI run out of the box and gives tests a deterministic
// stream. Same signature as runTask so the UI can't tell them apart.
import type { ModelMessage } from "ai";
import type { OnEvent, Usage } from "./events.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function stream(text: string, onEvent: OnEvent, chunk = 3, delay = 8) {
  for (let i = 0; i < text.length; i += chunk) {
    onEvent({ type: "text", text: text.slice(i, i + chunk) });
    await sleep(delay);
  }
}

export async function runTaskMock(opts: {
  prompt: string;
  messages: ModelMessage[];
  onEvent: OnEvent;
  signal?: AbortSignal;
}): Promise<{ messages: ModelMessage[]; usage: Usage }> {
  const { prompt, messages, onEvent, signal } = opts;
  const stop = () => signal?.aborted === true;

  await stream("Sure — let me take a look around first.\n", onEvent);
  if (stop()) return done(messages, onEvent);
  onEvent({ type: "tool-start", id: "1", name: "list_dir", arg: "." });
  await sleep(260);
  if (stop()) return done(messages, onEvent);
  onEvent({ type: "tool-end", id: "1", ok: true, summary: "src · package.json · README.md · 5 more" });

  onEvent({ type: "tool-start", id: "2", name: "read_file", arg: "src/cli.tsx" });
  await sleep(220);
  if (stop()) return done(messages, onEvent);
  onEvent({ type: "tool-end", id: "2", ok: true, summary: "renders the Ink app · 38 lines" });

  await stream(`\nThis is demo mode — no API key is set, so I'm not calling a real model. ` +
    `Set ANTHROPIC_API_KEY (or OPENAI / GOOGLE / DEEPSEEK) and I'll actually work on: "${prompt}".\n`, onEvent);

  return done(messages, onEvent);
}

function done(messages: ModelMessage[], onEvent: OnEvent) {
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };
  onEvent({ type: "done", usage });
  return { messages, usage };
}
