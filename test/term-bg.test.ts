import { expect, test } from "bun:test";
import { parseOsc11, isLightLuminance, colorFgBgIsLight, stripProbeReplies } from "../src/ui/term-bg.ts";

test("parseOsc11 reads 16-bit-per-channel replies (the common shape)", () => {
  // iTerm2/Ghostty white background
  expect(parseOsc11("\x1b]11;rgb:ffff/ffff/ffff\x07")!).toBeCloseTo(1, 3);
  // near-black
  expect(parseOsc11("\x1b]11;rgb:0000/0000/0000\x1b\\")!).toBeCloseTo(0, 3);
});

test("parseOsc11 handles 8-bit channels and rgba replies", () => {
  expect(parseOsc11("\x1b]11;rgb:ff/ff/ff\x07")!).toBeCloseTo(1, 3);
  expect(parseOsc11("\x1b]11;rgba:ffff/ffff/ffff\x07")!).toBeCloseTo(1, 3);
});

test("parseOsc11 rejects non-replies", () => {
  expect(parseOsc11("hello")).toBeNull();
  expect(parseOsc11("\x1b[13;2u")).toBeNull();
  expect(parseOsc11("")).toBeNull();
});

test("luminance threshold: white light, black dark, solarized-light light, solarized-dark dark", () => {
  expect(isLightLuminance(parseOsc11("\x1b]11;rgb:ffff/ffff/ffff\x07")!)).toBe(true);
  expect(isLightLuminance(parseOsc11("\x1b]11;rgb:0b0b/0b0b/1010\x07")!)).toBe(false);
  // solarized light base3 #fdf6e3
  expect(isLightLuminance(parseOsc11("\x1b]11;rgb:fdfd/f6f6/e3e3\x07")!)).toBe(true);
  // solarized dark base03 #002b36
  expect(isLightLuminance(parseOsc11("\x1b]11;rgb:0000/2b2b/3636\x07")!)).toBe(false);
});

test("COLORFGBG fallback: bg index decides; malformed → null", () => {
  expect(colorFgBgIsLight("0;15")).toBe(true); // black on white
  expect(colorFgBgIsLight("15;0")).toBe(false); // white on black
  expect(colorFgBgIsLight("12;8")).toBe(false); // dark gray bg
  expect(colorFgBgIsLight("0;7")).toBe(true); // light gray bg
  expect(colorFgBgIsLight("default;default")).toBeNull();
  expect(colorFgBgIsLight(undefined)).toBeNull();
  expect(colorFgBgIsLight("")).toBeNull();
});

test("parseOsc11 requires a terminator — a partial reply keeps accumulating", () => {
  expect(parseOsc11("\x1b]11;rgb:ffff/ffff")).toBeNull();
  expect(parseOsc11("\x1b]11;rgb:ffff/ffff/ff")).toBeNull(); // truncated mid-channel
});

test("stripProbeReplies removes elicited replies and keeps user keystrokes", () => {
  // keystroke + OSC11 reply + DA1 reply interleaved, in arrival order
  const buf = "h\x1b]11;rgb:1e1e/1e1e/1e1e\x1b\\i\x1b[?62;c!";
  expect(stripProbeReplies(buf)).toBe("hi!");
  expect(stripProbeReplies("\x1b]11;rgb:ffff/ffff/ffff\x07")).toBe("");
  expect(stripProbeReplies("plain typing")).toBe("plain typing");
});
