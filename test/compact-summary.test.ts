import { test, expect } from "bun:test";
import type { ModelMessage } from "ai";
import { parseCompactionSummary } from "../src/context/compact-summary.ts";
import {
  applyVerificationPatch,
  verifyCompactionSummary,
} from "../src/context/compact-verify.ts";

test("parseCompactionSummary parses JSON into a rendered durable note", () => {
  const parsed = parseCompactionSummary(
    JSON.stringify({
      goals: ["fix auth"],
      decisions: ["keep retry bounded"],
      files: [
        { path: "src/accounts/health.ts", change: "classified expired tokens" },
      ],
      commands: [
        { command: "bun test test/health.test.ts", outcome: "passed" },
      ],
      facts: ["health checks are cached"],
      openThreads: ["wire archive recall"],
      topics: [
        {
          title: "auth",
          notes: ["token expiry"],
          files: ["src/accounts/health.ts"],
        },
      ],
    })
  );
  expect(parsed.structured?.files[0]?.path).toBe("src/accounts/health.ts");
  expect(parsed.text).toContain("Files");
  expect(parsed.text).toContain("bun test test/health.test.ts");
});

test("parseCompactionSummary falls back to plaintext", () => {
  const parsed = parseCompactionSummary("- fixed auth");
  expect(parsed.structured).toBeUndefined();
  expect(parsed.text).toBe("- fixed auth");
});

test("verifyCompactionSummary patches missing mandatory anchors", () => {
  const old: ModelMessage[] = [
    { role: "user", content: "must keep the retry bounded" },
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "1",
          toolName: "edit_file",
          input: { path: "src/accounts/health.ts" },
        },
      ] as any,
    },
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "2",
          toolName: "run_shell",
          input: { command: "bun test test/health.test.ts" },
        },
      ] as any,
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "2",
          toolName: "run_shell",
          output: { type: "text", value: "failed: token expired error" },
        },
      ] as any,
    },
  ];
  const verification = verifyCompactionSummary("Worked on auth.", old);
  expect(verification.ok).toBe(false);
  expect(verification.missingFiles).toContain("src/accounts/health.ts");
  expect(verification.missingCommands).toContain(
    "bun test test/health.test.ts"
  );
  expect(verification.missingConstraints[0]).toContain("must keep");
  const patched = applyVerificationPatch("Worked on auth.", verification);
  expect(patched).toContain("Verification patch");
  expect(patched).toContain("src/accounts/health.ts");
});
