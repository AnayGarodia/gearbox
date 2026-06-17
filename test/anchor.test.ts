import { test, expect, describe } from "bun:test";
import { anchorLayout } from "../src/ui/anchor.ts";

// The first prompt sits at line 0 (it's the first transcript item).
const base = { anchorTop: true, anchorOffset: 0, transcriptHeight: 20, atBottom: false, scrollTop: 0 };

describe("anchorLayout", () => {
  test("a fitting anchored turn pins the prompt to the top (spacer below, scroll 0)", () => {
    const v = anchorLayout({ ...base, linesLength: 6 });
    expect(v.anchorActive).toBe(true);
    expect(v.spacerLen).toBe(14); // 20 − 6, pads below so the prompt reaches row 0
    expect(v.effScroll).toBe(0); // prompt at the very top
    expect(v.followTail).toBe(false);
  });

  test("an overflowing anchored turn follows the live tail without disarming", () => {
    const v = anchorLayout({ ...base, linesLength: 50, atBottom: true });
    expect(v.anchorActive).toBe(false); // can't pin the top while overflowing
    expect(v.spacerLen).toBe(0);
    expect(v.followTail).toBe(true); // signal to keep following the tail, anchor STILL armed
    expect(v.effScroll).toBe(v.maxScroll); // bottom of the buffer
    expect(v.maxScroll).toBe(30); // 50 − 20
  });

  test("REGRESSION: a turn that overflowed and then collapses back re-pins to the top", () => {
    // Mid-turn: tall live trace overflows → followTail (the App keeps anchorTop true).
    const overflowing = anchorLayout({ ...base, linesLength: 50, atBottom: true });
    expect(overflowing.followTail).toBe(true);
    expect(overflowing.anchorActive).toBe(false);
    // At settle: collapseTurn shrinks the trace + the Working footer frees rows, so
    // the SAME armed anchor now fits → it must snap back to the top, NOT bottom-align.
    const settled = anchorLayout({ ...base, linesLength: 8, atBottom: true });
    expect(settled.anchorActive).toBe(true);
    expect(settled.effScroll).toBe(0); // first input back at the top — the bug was it stayed at the bottom
  });

  test("not anchored → bottom-align math (effScroll follows tail / honors manual scroll)", () => {
    const tail = anchorLayout({ anchorTop: false, anchorOffset: null, linesLength: 50, transcriptHeight: 20, atBottom: true, scrollTop: 0 });
    expect(tail.anchorActive).toBe(false);
    expect(tail.followTail).toBe(false); // not armed
    expect(tail.effScroll).toBe(30);
    const scrolled = anchorLayout({ anchorTop: false, anchorOffset: null, linesLength: 50, transcriptHeight: 20, atBottom: false, scrollTop: 5 });
    expect(scrolled.effScroll).toBe(5); // honors the user's manual position
  });

  test("exactly-fits boundary stays anchored (content == height)", () => {
    const v = anchorLayout({ ...base, linesLength: 20 });
    expect(v.anchorActive).toBe(true);
    expect(v.spacerLen).toBe(0);
    expect(v.followTail).toBe(false);
    expect(v.effScroll).toBe(0);
  });

  test("one line past fitting flips to follow-tail", () => {
    const v = anchorLayout({ ...base, linesLength: 21, atBottom: true });
    expect(v.anchorActive).toBe(false);
    expect(v.followTail).toBe(true);
  });
});
