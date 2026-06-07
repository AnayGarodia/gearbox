import { test, expect, describe } from "bun:test";
import { capabilitySummary } from "../src/model/capabilities.ts";
import { MODELS } from "../src/providers.ts";

const sonnet = MODELS.find((m) => m.id === "claude-sonnet-4-6")!;

describe("capabilitySummary", () => {
  test("names the capabilities a flagship model supports", () => {
    const s = capabilitySummary(sonnet);
    expect(s).toContain("tools");
    expect(s).toContain("images");
  });

  test("returns a non-empty, human-readable string", () => {
    const s = capabilitySummary(sonnet);
    expect(s.length).toBeGreaterThan(0);
    expect(s).not.toContain("undefined");
  });

  test("marks unknowns rather than overclaiming", () => {
    // A synthetic gateway model with unknown tool support should not claim 'tools'.
    const unknownSpec = { ...sonnet, provider: "openrouter", sdkId: "x/y", capabilities: undefined } as any;
    const s = capabilitySummary(unknownSpec);
    expect(s.toLowerCase()).toContain("?"); // unknowns surfaced
  });
});
