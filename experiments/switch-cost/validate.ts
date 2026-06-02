// Structural validators + a cross-provider fidelity check.
// The fidelity check is the real test: the SAME canonical state must project
// into all three providers with identical semantics (tool-call count, results,
// text) — no information dropped, duplicated, or mis-paired by any renderer.

export type Check = { check: string; pass: boolean; detail: string };

function ok(check: string, cond: boolean, detail = ""): Check {
  return { check, pass: cond, detail };
}

// ---- Anthropic structural ----
export function checkAnthropic(p: any): Check[] {
  const c: Check[] = [];
  c.push(ok("anthropic: system is string", typeof p.system === "string"));
  c.push(ok("anthropic: tools use input_schema", p.tools.every((t: any) => t.input_schema?.type === "object")));
  const roles = p.messages.map((m: any) => m.role);
  c.push(ok("anthropic: only user/assistant roles", roles.every((r: string) => r === "user" || r === "assistant")));
  let alt = roles[0] === "user";
  for (let i = 1; i < roles.length; i++) if (roles[i] === roles[i - 1]) alt = false;
  c.push(ok("anthropic: strict user/assistant alternation, starts user", alt, roles.join(",")));
  const useIds = new Set<string>(), resIds = new Set<string>();
  for (const m of p.messages)
    for (const b of m.content) {
      if (b.type === "tool_use") useIds.add(b.id);
      if (b.type === "tool_result") resIds.add(b.tool_use_id);
    }
  c.push(ok("anthropic: every tool_use has matching tool_result", [...useIds].every((id) => resIds.has(id)), `calls=${useIds.size} results=${resIds.size}`));
  return c;
}

// ---- OpenAI structural ----
export function checkOpenAI(p: any): Check[] {
  const c: Check[] = [];
  c.push(ok("openai: first message is system", p.messages[0]?.role === "system"));
  c.push(ok("openai: tools are type=function", p.tools.every((t: any) => t.type === "function" && t.function?.parameters)));
  const callIds = new Set<string>(), toolMsgIds = new Set<string>();
  let argsAllStrings = true;
  for (const m of p.messages) {
    if (m.role === "assistant" && m.tool_calls)
      for (const tc of m.tool_calls) {
        callIds.add(tc.id);
        if (typeof tc.function.arguments !== "string") argsAllStrings = false;
        else try { JSON.parse(tc.function.arguments); } catch { argsAllStrings = false; }
      }
    if (m.role === "tool") toolMsgIds.add(m.tool_call_id);
  }
  c.push(ok("openai: tool_call.arguments are JSON strings", argsAllStrings));
  c.push(ok("openai: every tool_call has a tool message reply", [...callIds].every((id) => toolMsgIds.has(id)), `calls=${callIds.size} toolMsgs=${toolMsgIds.size}`));
  return c;
}

// ---- Gemini structural ----
export function checkGemini(p: any): Check[] {
  const c: Check[] = [];
  c.push(ok("gemini: has systemInstruction", !!p.systemInstruction?.parts?.[0]?.text));
  c.push(ok("gemini: functionDeclarations present", Array.isArray(p.tools[0]?.functionDeclarations)));
  const roles = p.contents.map((m: any) => m.role);
  c.push(ok("gemini: only user/model roles (no assistant/system leak)", roles.every((r: string) => r === "user" || r === "model")));
  let alt = roles[0] === "user";
  for (let i = 1; i < roles.length; i++) if (roles[i] === roles[i - 1]) alt = false;
  c.push(ok("gemini: strict user/model alternation, starts user", alt, roles.join(",")));
  const calls: string[] = [], resps: string[] = [];
  for (const m of p.contents)
    for (const part of m.parts) {
      if (part.functionCall) calls.push(part.functionCall.name);
      if (part.functionResponse) resps.push(part.functionResponse.name);
    }
  c.push(ok("gemini: functionCall/Response names balance", calls.sort().join() === resps.sort().join(), `calls=${calls.length} resps=${resps.length}`));
  return c;
}

// ---- cross-provider fidelity ----
type Sig = { nCalls: number; nResults: number; userText: string; asstText: string };
const norm = (s: string) => s.replace(/\s+/g, " ").trim();

function sigAnthropic(p: any): Sig {
  let nCalls = 0, nResults = 0, userText = "", asstText = "";
  for (const m of p.messages)
    for (const b of m.content) {
      if (b.type === "tool_use") nCalls++;
      else if (b.type === "tool_result") nResults++;
      else if (b.type === "text") (m.role === "user" ? (userText += b.text) : (asstText += b.text));
    }
  return { nCalls, nResults, userText: norm(userText), asstText: norm(asstText) };
}
function sigOpenAI(p: any): Sig {
  let nCalls = 0, nResults = 0, userText = "", asstText = "";
  for (const m of p.messages) {
    if (m.role === "assistant") { if (m.tool_calls) nCalls += m.tool_calls.length; if (m.content) asstText += m.content; }
    else if (m.role === "tool") nResults++;
    else if (m.role === "user") userText += m.content;
  }
  return { nCalls, nResults, userText: norm(userText), asstText: norm(asstText) };
}
function sigGemini(p: any): Sig {
  let nCalls = 0, nResults = 0, userText = "", asstText = "";
  for (const m of p.contents)
    for (const part of m.parts) {
      if (part.functionCall) nCalls++;
      else if (part.functionResponse) nResults++;
      else if (part.text) (m.role === "user" ? (userText += part.text) : (asstText += part.text));
    }
  return { nCalls, nResults, userText: norm(userText), asstText: norm(asstText) };
}

export function checkFidelity(a: any, o: any, g: any): Check[] {
  const sa = sigAnthropic(a), so = sigOpenAI(o), sg = sigGemini(g);
  const eqN = sa.nCalls === so.nCalls && so.nCalls === sg.nCalls && sa.nResults === so.nResults && so.nResults === sg.nResults;
  const eqUser = sa.userText === so.userText && so.userText === sg.userText;
  const eqAsst = sa.asstText === so.asstText && so.asstText === sg.asstText;
  return [
    ok("fidelity: tool-call & result COUNTS identical across providers", eqN, `A(${sa.nCalls}/${sa.nResults}) O(${so.nCalls}/${so.nResults}) G(${sg.nCalls}/${sg.nResults})`),
    ok("fidelity: user text identical across providers", eqUser),
    ok("fidelity: assistant text identical across providers", eqAsst),
  ];
}
