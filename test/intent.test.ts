import { test, expect } from "bun:test";
import { matchIntent } from "../src/ui/intent.ts";

test("recognizes add-account phrasings", () => {
  for (const s of ["add an account", "add my openai key", "connect anthropic", "set up a claude subscription", "add openrouter", "sign in to chatgpt"]) {
    expect(matchIntent(s)?.command, s).toBe("/account add");
  }
});

test("recognizes spend / usage questions", () => {
  for (const s of ["what have i spent", "how much have i spent", "my usage", "show me my spend", "how much is this costing"]) {
    expect(matchIntent(s)?.command, s).toBe("/usage");
  }
});

test("recognizes model switches (verb + model word)", () => {
  expect(matchIntent("use opus")?.command).toBe("/model opus");
  expect(matchIntent("switch to haiku")?.command).toBe("/model haiku");
  expect(matchIntent("change to gpt-5")?.command).toBe("/model gpt-5");
});

test("recognizes why / list intents", () => {
  expect(matchIntent("why this model")?.command).toBe("/why");
  expect(matchIntent("why?")?.command).toBe("/why");
  expect(matchIntent("list my accounts")?.command).toBe("/account");
  expect(matchIntent("show models")?.command).toBe("/model");
});

test("does NOT hijack real coding tasks", () => {
  for (const s of [
    "add error handling to the auth provider in this file",
    "add a key to the map and return it",
    "use a binary search here instead of the linear scan",
    "switch the layout to flexbox",
    "what does this function do",
    "refactor the account model to support multiple providers cleanly please now",
    "write a test for the usage aggregator",
    "change the cost calculation to round up",
  ]) {
    expect(matchIntent(s), s).toBeNull();
  }
});

test("ignores slash/bang/hash/at and empty", () => {
  expect(matchIntent("/account")).toBeNull();
  expect(matchIntent("!ls")).toBeNull();
  expect(matchIntent("#note")).toBeNull();
  expect(matchIntent("")).toBeNull();
});
