// Renderers: project CanonicalState into each provider's native wire format.
// This is the load-bearing claim of the whole architecture. If one canonical
// state can be faithfully rendered into all three genuinely-different schemas,
// then model switching is "re-render", not "replay a provider-locked transcript".

import type { CanonicalState, Turn, ToolDef } from "./canonical.ts";

// --- group flat turns by speaker (user-side vs assistant-side) ---
// tool_result is a USER-side event for Anthropic/Gemini, but a separate `tool`
// role for OpenAI. Grouping by speaker first makes alternation correct.
type Speaker = "user" | "assistant";
function speakerOf(t: Turn): Speaker {
  switch (t.kind) {
    case "user_text":
    case "tool_result":
      return "user";
    default:
      return "assistant";
  }
}
function groupBySpeaker(turns: Turn[]): { speaker: Speaker; items: Turn[] }[] {
  const segs: { speaker: Speaker; items: Turn[] }[] = [];
  for (const t of turns) {
    const sp = speakerOf(t);
    const last = segs[segs.length - 1];
    if (last && last.speaker === sp) last.items.push(t);
    else segs.push({ speaker: sp, items: [t] });
  }
  return segs;
}

// ============ ANTHROPIC (Messages API) ============
export function renderAnthropic(s: CanonicalState) {
  const messages = groupBySpeaker(s.turns).map((seg) => {
    const content: any[] = [];
    for (const t of seg.items) {
      if (t.kind === "user_text") content.push({ type: "text", text: t.text });
      else if (t.kind === "assistant_text") content.push({ type: "text", text: t.text });
      else if (t.kind === "thinking") content.push({ type: "text", text: `[thinking] ${t.text}` });
      else if (t.kind === "assistant_tool_call")
        content.push({ type: "tool_use", id: t.callId, name: t.name, input: t.args });
      else if (t.kind === "tool_result")
        content.push({ type: "tool_result", tool_use_id: t.callId, content: t.result });
    }
    return { role: seg.speaker, content };
  });
  return {
    model: "<model>",
    max_tokens: 4096,
    system: s.system, // top-level system (Anthropic-specific)
    tools: s.tools.map((t: ToolDef) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters, // Anthropic calls it input_schema
    })),
    messages,
  };
}

// ============ OPENAI (Chat Completions) ============
export function renderOpenAI(s: CanonicalState) {
  const messages: any[] = [{ role: "system", content: s.system }]; // system as a message
  for (const seg of groupBySpeaker(s.turns)) {
    if (seg.speaker === "assistant") {
      // one assistant message: text content + tool_calls array
      let text = "";
      const tool_calls: any[] = [];
      for (const t of seg.items) {
        if (t.kind === "assistant_text") text += t.text;
        else if (t.kind === "thinking") text += `[thinking] ${t.text}`;
        else if (t.kind === "assistant_tool_call")
          tool_calls.push({
            id: t.callId,
            type: "function",
            function: { name: t.name, arguments: JSON.stringify(t.args) }, // MUST be a string
          });
      }
      const msg: any = { role: "assistant", content: text || null };
      if (tool_calls.length) msg.tool_calls = tool_calls;
      messages.push(msg);
    } else {
      // user-side: user_text -> user msg; tool_result -> separate `tool` msg
      for (const t of seg.items) {
        if (t.kind === "user_text") messages.push({ role: "user", content: t.text });
        else if (t.kind === "tool_result")
          messages.push({ role: "tool", tool_call_id: t.callId, content: t.result });
      }
    }
  }
  return {
    model: "<model>",
    tools: s.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    })),
    messages,
  };
}

// ============ GEMINI (generateContent) ============
export function renderGemini(s: CanonicalState) {
  const contents = groupBySpeaker(s.turns).map((seg) => {
    const parts: any[] = [];
    for (const t of seg.items) {
      if (t.kind === "user_text") parts.push({ text: t.text });
      else if (t.kind === "assistant_text") parts.push({ text: t.text });
      else if (t.kind === "thinking") parts.push({ text: `[thinking] ${t.text}` });
      else if (t.kind === "assistant_tool_call")
        parts.push({ functionCall: { name: t.name, args: t.args } });
      else if (t.kind === "tool_result")
        // NOTE: Gemini matches by NAME, has no call-id. Real wrinkle for parallel
        // calls to the same fn — surfaced in the report as a known limitation.
        parts.push({ functionResponse: { name: t.name, response: { result: t.result } } });
    }
    return { role: seg.speaker === "assistant" ? "model" : "user", parts }; // assistant -> model
  });
  return {
    systemInstruction: { parts: [{ text: s.system }] }, // system as systemInstruction
    tools: [
      {
        functionDeclarations: s.tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
      },
    ],
    contents,
  };
}
