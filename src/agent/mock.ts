// Scripted runner fixture: emits the same AgentEvents the real loop does with no
// provider call. Tests use this for a deterministic stream.
import type { ModelMessage } from "ai";
import type { OnEvent, Usage } from "./events.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function stream(text: string, onEvent: OnEvent, chunk = 3, delay = 8) {
  for (let i = 0; i < text.length; i += chunk) {
    onEvent({ type: "text", text: text.slice(i, i + chunk) });
    await sleep(delay);
  }
}

// Stream a file write the way the real loop does: tool-start → streamed content →
// tool-end with diff, so the mock exercise the same UI path as live tool calls.
async function streamWrite(id: string, path: string, content: string, onEvent: OnEvent, stop: () => boolean) {
  onEvent({ type: "tool-start", id, name: "write_file", arg: "" });
  onEvent({ type: "tool-stream", id, arg: path });
  for (let i = 0; i < content.length; i += 8) {
    if (stop()) return;
    onEvent({ type: "tool-stream", id, delta: content.slice(i, i + 8) });
    await sleep(16);
  }
  const diff = content.replace(/\n$/, "").split("\n").map((text) => ({ sign: "+" as const, text }));
  onEvent({ type: "tool-end", id, ok: true, summary: `wrote ${path} (+${diff.length} −0)`, diff });
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

  await stream(`\nHere's a quick file — watch it stream in:\n`, onEvent);
  if (stop()) return done(messages, onEvent);
  const demoFile = `# hello.py — written by the scripted test runner\n\ndef greet(name: str) -> str:\n    return f"Hello, {name}!"\n\nif __name__ == "__main__":\n    for who in ("world", "gearbox", "Boo"):\n        print(greet(who))\n`;
  await streamWrite("3", "hello.py", demoFile, onEvent, stop);
  if (stop()) return done(messages, onEvent);

  await stream(`\nThis is the scripted test runner, so no provider call was made. ` +
    `A real session would work on: "${prompt}".\n`, onEvent);

  return done(messages, onEvent);
}

function done(messages: ModelMessage[], onEvent: OnEvent) {
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };
  onEvent({ type: "done", usage });
  return { messages, usage };
}
