import { test, expect } from "bun:test";
import { formatDuration } from "../src/ui/App.tsx";

test("formatDuration carries rounded seconds into minutes (no '1m 60s')", () => {
  expect(formatDuration(4200)).toBe("4.2s");
  expect(formatDuration(83_000)).toBe("1m 23s");
  // 119.6s rounded was the bug: floor→1m, round(59.6)→60 → "1m 60s". Now "2m 0s".
  expect(formatDuration(119_600)).toBe("2m 0s");
  // 59.96s must carry to a full minute, not print "60.0s".
  expect(formatDuration(59_960)).toBe("1m 0s");
  expect(formatDuration(120_000)).toBe("2m 0s");
  // sub-second never reads 0.0s
  expect(formatDuration(10)).toBe("0.1s");
  expect(formatDuration(0)).toBe("0.1s");
  // exactly a minute
  expect(formatDuration(60_000)).toBe("1m 0s");
  expect(formatDuration(90_000)).toBe("1m 30s");
});
