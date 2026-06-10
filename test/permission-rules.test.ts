// .gearbox/permissions.json — pre-decided permissions by kind + glob.
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ruleFor, loadPermissionRules, clearPermissionRulesCache } from "../src/permission-rules.ts";
import { requestPermission, resetPermissions, setPermissionHandler, setYolo } from "../src/permission.ts";

let home: string, proj: string;
const saved = process.env.GEARBOX_HOME;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "gearbox-rules-home-"));
  proj = mkdtempSync(join(tmpdir(), "gearbox-rules-proj-"));
  process.env.GEARBOX_HOME = home;
  clearPermissionRulesCache();
  resetPermissions();
});
afterEach(() => {
  if (saved === undefined) delete process.env.GEARBOX_HOME;
  else process.env.GEARBOX_HOME = saved;
  clearPermissionRulesCache();
  resetPermissions();
  setPermissionHandler(null);
});

test("ruleFor: longest matching glob wins; blanket strings apply to everything", () => {
  const rules = { shell: { "git *": "allow", "git push*": "ask", "rm *": "deny" }, write: "allow" } as const;
  expect(ruleFor(rules as any, "shell", "git status")).toBe("allow");
  expect(ruleFor(rules as any, "shell", "git push origin main")).toBe("ask"); // longer glob beats "git *"
  expect(ruleFor(rules as any, "shell", "rm -rf /tmp/x")).toBe("deny");
  expect(ruleFor(rules as any, "shell", "bun test")).toBeNull(); // unmatched → interactive broker
  expect(ruleFor(rules as any, "write", "anything.ts")).toBe("allow");
  expect(ruleFor(null, "shell", "ls")).toBeNull();
});

test("project rules override global; merge is per-glob", () => {
  writeFileSync(join(home, "permissions.json"), JSON.stringify({ shell: { "git push*": "allow", "npm *": "deny" } }));
  mkdirSync(join(proj, ".gearbox"), { recursive: true });
  writeFileSync(join(proj, ".gearbox", "permissions.json"), JSON.stringify({ shell: { "git push*": "ask" } }));
  const rules = loadPermissionRules(proj)!;
  expect(ruleFor(rules, "shell", "git push")).toBe("ask"); // project wins
  expect(ruleFor(rules, "shell", "npm install")).toBe("deny"); // global survives the merge
});

test("a written 'deny' refuses even under yolo (the whole point of writing it down)", async () => {
  mkdirSync(join(process.cwd(), ".gearbox"), { recursive: true });
  // use the GLOBAL file instead — cwd is the repo; don't pollute it
  writeFileSync(join(home, "permissions.json"), JSON.stringify({ shell: { "rm -rf *": "deny" } }));
  clearPermissionRulesCache();
  setYolo(true);
  expect(await requestPermission({ kind: "shell", title: "Run", detail: "rm -rf /" })).toBe(false);
  expect(await requestPermission({ kind: "shell", title: "Run", detail: "ls" })).toBe(true); // yolo still covers the rest
  setYolo(false);
});

test("an 'allow' rule skips the prompt; 'ask' forces one past a standing grant", async () => {
  writeFileSync(join(home, "permissions.json"), JSON.stringify({ shell: { "bun test*": "allow", "git push*": "ask" } }));
  clearPermissionRulesCache();
  let prompts = 0;
  setPermissionHandler(async () => { prompts++; return "always"; });
  expect(await requestPermission({ kind: "shell", title: "Run", detail: "bun test" })).toBe(true);
  expect(prompts).toBe(0); // allowed without asking
  await requestPermission({ kind: "shell", title: "Run", detail: "make build" }); // grants "always" for shell
  expect(prompts).toBe(1);
  await requestPermission({ kind: "shell", title: "Run", detail: "git push origin main" });
  expect(prompts).toBe(2); // 'ask' punches through the standing grant
});
