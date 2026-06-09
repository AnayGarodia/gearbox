// The /commit + /pr review panel: pure state machine (edit subject in place,
// read-only body, ⏎ executes — App wires the keys; these are the reducers).
import { test, expect } from "bun:test";
import {
  gitConfirmOpen, gitConfirmEdit, gitConfirmSetSubmitting, gitConfirmError,
  gitConfirmReady, gitConfirmMessage,
} from "../src/ui/panel.ts";

const base = () =>
  gitConfirmOpen({ mode: "commit", subject: "fix the parser", body: "Handles the empty-input case.", files: ["src/p.ts"], stat: "1 file changed" });

test("open: subject editable with the caret at the end; body read-only alongside", () => {
  const p = base();
  expect(p.kind).toBe("git-confirm");
  expect(p.subject.value).toBe("fix the parser");
  expect(p.subject.cursor).toBe("fix the parser".length);
  expect(p.body).toBe("Handles the empty-input case.");
  expect(p.submitting).toBe(false);
  expect(p.title).toContain("commit");
  expect(gitConfirmOpen({ mode: "pr", subject: "t", body: "", files: [], stat: "" }).title).toContain("pull request");
});

test("edit replaces the subject and clears a prior error", () => {
  const p = gitConfirmError(base(), "boom");
  const e = gitConfirmEdit(p, { value: "better subject", cursor: 3 });
  expect(e.subject.value).toBe("better subject");
  expect(e.error).toBeUndefined();
});

test("ready requires a non-blank subject", () => {
  expect(gitConfirmReady(base())).toBe(true);
  expect(gitConfirmReady(gitConfirmEdit(base(), { value: "   ", cursor: 0 }))).toBe(false);
});

test("message = subject + blank line + body; subject-only when no body", () => {
  expect(gitConfirmMessage(base())).toBe("fix the parser\n\nHandles the empty-input case.");
  const noBody = gitConfirmOpen({ mode: "commit", subject: "tiny fix", body: "", files: [], stat: "" });
  expect(gitConfirmMessage(noBody)).toBe("tiny fix");
});

test("submitting flag + error reset", () => {
  const s = gitConfirmSetSubmitting(base(), true);
  expect(s.submitting).toBe(true);
  const err = gitConfirmError(s, "nothing to commit");
  expect(err.submitting).toBe(false);
  expect(err.error).toBe("nothing to commit");
});
