import { test, expect } from "bun:test";
import {
  wizardOpen,
  wizardPickMove,
  wizardPickFilter,
  wizardPickBackspace,
  wizardPickConfirm,
  wizardFieldEdit,
  wizardFieldError,
  wizardFieldAdvance,
  wizardIsComplete,
  wizardBack,
  type WizardPanel,
} from "../src/ui/panel.ts";
import type { AddSpec } from "../src/accounts/add-spec.ts";

// A tiny two-field spec so the reducers can be tested without the real catalog/store.
const SPEC: AddSpec = {
  id: "demo",
  label: "Demo",
  summary: "two fields",
  group: "cloud",
  paletteCommand: "/account add demo",
  fields: [
    { key: "a", label: "A", placeholder: "a", required: true, validate: (v) => (v === "bad" ? "no good" : null) },
    { key: "b", label: "B", placeholder: "b", required: true, validate: () => null },
  ],
  build: async () => ({ ok: true, message: "built" }),
};

const asPick = (p: WizardPanel) => p.wizardPhase as Extract<WizardPanel["wizardPhase"], { phase: "pick" }>;
const asField = (p: WizardPanel) => p.wizardPhase as Extract<WizardPanel["wizardPhase"], { phase: "field" }>;

test("wizardOpen starts at the pick phase", () => {
  const p = wizardOpen("add");
  expect(p.kind).toBe("wizard");
  expect(asPick(p).phase).toBe("pick");
  expect(asPick(p).index).toBe(0);
  expect(asPick(p).filter).toBe("");
});

test("pick move clamps, filter resets the index", () => {
  let p = wizardOpen("add");
  p = wizardPickMove(p, 3, 5); // count 5 → max index 4
  expect(asPick(p).index).toBe(3);
  p = wizardPickMove(p, 10, 5);
  expect(asPick(p).index).toBe(4); // clamped
  p = wizardPickFilter(p, "a");
  expect(asPick(p).filter).toBe("a");
  expect(asPick(p).index).toBe(0); // reset on filter
  p = wizardPickFilter(p, "z");
  expect(asPick(p).filter).toBe("az");
  p = wizardPickBackspace(p);
  expect(asPick(p).filter).toBe("a");
});

test("confirm enters the field phase at field 0 with an empty edit", () => {
  const p = wizardPickConfirm(wizardOpen("add"), "demo");
  const ph = asField(p);
  expect(ph.phase).toBe("field");
  expect(ph.specId).toBe("demo");
  expect(ph.fieldIndex).toBe(0);
  expect(ph.fieldEdit.value).toBe("");
  expect(ph.filled).toEqual({});
});

test("a failing field validation sets the inline error and does not advance", () => {
  let p = wizardPickConfirm(wizardOpen("add"), "demo");
  p = wizardFieldEdit(p, { value: "bad", cursor: 3 });
  p = wizardFieldAdvance(p, SPEC);
  expect(asField(p).fieldIndex).toBe(0); // stayed
  expect(asField(p).fieldError).toBe("no good");
});

test("editing clears a prior error; advancing stores the value and walks to completion", () => {
  let p = wizardPickConfirm(wizardOpen("add"), "demo");
  p = wizardFieldError(p, "stale");
  p = wizardFieldEdit(p, { value: "ok", cursor: 2 });
  expect(asField(p).fieldError).toBeNull(); // cleared on edit
  p = wizardFieldAdvance(p, SPEC);
  expect(asField(p).fieldIndex).toBe(1);
  expect(asField(p).filled).toEqual({ a: "ok" });
  expect(asField(p).fieldEdit.value).toBe(""); // fresh edit for next field
  expect(wizardIsComplete(p, SPEC)).toBe(false);

  p = wizardFieldEdit(p, { value: "two", cursor: 3 });
  p = wizardFieldAdvance(p, SPEC);
  expect(asField(p).fieldIndex).toBe(2); // == fields.length → complete sentinel
  expect(wizardIsComplete(p, SPEC)).toBe(true);
  expect(asField(p).filled).toEqual({ a: "ok", b: "two" });
});

test("back from a later field restores the prior value; back from field 0 returns to pick", () => {
  let p = wizardPickConfirm(wizardOpen("add"), "demo");
  p = wizardFieldEdit(p, { value: "first", cursor: 5 });
  p = wizardFieldAdvance(p, SPEC); // now on field 1, filled.a = "first"
  p = wizardBack(p, SPEC);
  expect(asField(p).fieldIndex).toBe(0);
  expect(asField(p).fieldEdit.value).toBe("first"); // restored
  p = wizardBack(p, SPEC); // from field 0 → pick
  expect(asPick(p).phase).toBe("pick");
});
