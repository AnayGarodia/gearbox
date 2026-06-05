import React from "react";
import { render } from "ink-testing-library";
import { Box } from "ink";
import { Banner } from "./src/ui/components/Banner.tsx";
import { Viewport } from "./src/ui/components/Viewport.tsx";
import { Working } from "./src/ui/components/Working.tsx";
import { Composer } from "./src/ui/components/Composer.tsx";
import { PermissionPrompt } from "./src/ui/components/PermissionPrompt.tsx";
import { StatusBar } from "./src/ui/components/StatusBar.tsx";
import { itemsToLines } from "./src/ui/lines.ts";
import type { Item } from "./src/ui/types.ts";
import { writeFileSync } from "node:fs";
const W = 118;
const items: Item[] = [
  { kind: "user", id: 1, text: "summarize the architecture and explain how routing will plug in once it lands, in a couple of sentences" },
  { kind: "assistant", id: 2, text: "The agent asks a **ModelSelector** for which model to use, so nothing hardcodes a model. Today it returns a fixed default; the router will implement the same interface and drop in with zero changes upstream. Every call captures token usage so the future cost engine has data to work with.", done: true },
  { kind: "tool", id: 3, callId: "a", name: "read", arg: "src/model/selector.ts", status: "ok", summary: "39 lines" },
];
const lines = itemsToLines(items, W - 3);
const H = 9;
const top = (extra: React.ReactNode) => (
  <Box flexDirection="column" width={W}>
    <Banner model="sonnet-4.6" cwd="~/Projects/gearbox" width={W} />
    <Box paddingX={1}><Viewport lines={lines} scrollTop={Math.max(0,lines.length-H)} height={H} width={W-2} /></Box>
    {extra}
  </Box>
);
const busyUI = top(<><Working verb="Meshing the cogs" elapsed={4} /><Composer value="" cursor={0} placeholder="ask anything" busy={true} width={W} /><StatusBar model="sonnet-4.6" branch="main" routing="fixed default" yolo={true} ctxPct={null} tokens={3100} width={W} /></>);
const permUI = (
  <Box flexDirection="column" width={W}>
    <PermissionPrompt req={{ kind: "shell", title: "Run a shell command", detail: "rm -rf build && bun run build" }} width={W} />
    <StatusBar model="sonnet-4.6" branch="main" routing="fixed default" yolo={false} ctxPct={null} tokens={1200} width={W} />
  </Box>
);
function toHtml(ansi: string) {
  const DEF_FG="#DCE2F7";let fg=DEF_FG,bg="transparent",bold=false;
  const esc=(s:string)=>s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  let html="";const re=/\[([0-9;]*)m/g;let last=0;let m;
  const open=()=>`<span style="color:${fg};background:${bg};${bold?'font-weight:700':''}">`;
  const flush=(t:string)=>{if(t)html+=open()+esc(t)+"</span>";};
  while((m=re.exec(ansi))){flush(ansi.slice(last,m.index));last=m.index+m[0].length;const cs=m[1].split(";").map(Number);for(let i=0;i<cs.length;i++){const c=cs[i];if(c===0){fg=DEF_FG;bg="transparent";bold=false;}else if(c===1)bold=true;else if(c===22)bold=false;else if(c===39)fg=DEF_FG;else if(c===49)bg="transparent";else if(c===38&&cs[i+1]===2){fg=`rgb(${cs[i+2]},${cs[i+3]},${cs[i+4]})`;i+=4;}else if(c===48&&cs[i+1]===2){bg=`rgb(${cs[i+2]},${cs[i+3]},${cs[i+4]})`;i+=4;}}}
  flush(ansi.slice(last));return html;
}
const a = render(busyUI); const b = render(permUI);
const wrap=(h:string)=>`<pre style="margin:0 0 18px;font:14px/1.5 'SF Mono',Menlo,monospace;background:#0C0E18;color:#DCE2F7;padding:14px 4px;border-radius:10px;border:1px solid #1b1f33;display:block">${h}</pre>`;
writeFileSync("/tmp/x.html",`<!doctype html><meta charset=utf8><body style="margin:0;background:#05060C;padding:24px">${wrap(toHtml(a.lastFrame()??""))}${wrap(toHtml(b.lastFrame()??""))}</body>`);
console.log("ok");
