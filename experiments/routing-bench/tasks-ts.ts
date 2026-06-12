// TypeScript fixture tasks — 20 self-contained mini-workspaces across three
// difficulty tiers. `visible: true` tasks ship a package.json test script and
// a visible test file, so the agent's VERIFY gate works (tests-tier routing);
// `visible: false` tasks ship no checks at all (none-tier routing — what the
// selfverify cascade and the expected-cost caution branch are for). The hidden
// judge test is written into the workspace by the RUNNER after the agent
// finishes, so no policy can see it.
import type { BenchTask } from "./types.ts";

const pkg = (withTest: boolean) =>
  JSON.stringify(withTest ? { name: "fixture", type: "module", scripts: { test: "bun test tests" } } : { name: "fixture", type: "module" }, null, 2);

export const TS_TASKS: BenchTask[] = [
  // ── T1: trivial ─────────────────────────────────────────────────────────
  {
    id: "ts-capitalize",
    tier: "T1",
    visible: true,
    prompt: "Add an exported function `capitalize(s: string): string` to src/strings.ts that uppercases the first character and leaves the rest unchanged. An empty string returns an empty string.",
    files: {
      "package.json": pkg(true),
      "src/strings.ts": `export function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
`,
      "tests/basic.test.ts": `import { test, expect } from "bun:test";
import { slugify } from "../src/strings.ts";

test("slugify still works", () => {
  expect(slugify("Hello World!")).toBe("hello-world");
});
`,
    },
    hidden: {
      kind: "bun",
      file: "__hidden__.test.ts",
      content: `import { test, expect } from "bun:test";
import { capitalize, slugify } from "./src/strings.ts";

test("capitalize basics", () => {
  expect(capitalize("hello")).toBe("Hello");
  expect(capitalize("hello world")).toBe("Hello world");
  expect(capitalize("")).toBe("");
  expect(capitalize("A")).toBe("A");
});

test("existing exports untouched", () => {
  expect(slugify("Hello World!")).toBe("hello-world");
});
`,
    },
  },
  {
    id: "ts-clamp",
    tier: "T1",
    visible: true,
    prompt: "Add an exported function `clamp(n: number, lo: number, hi: number): number` to src/math.ts that limits n to the inclusive range [lo, hi].",
    files: {
      "package.json": pkg(true),
      "src/math.ts": `export function sum(ns: number[]): number {
  return ns.reduce((a, b) => a + b, 0);
}
`,
      "tests/basic.test.ts": `import { test, expect } from "bun:test";
import { sum } from "../src/math.ts";

test("sum still works", () => {
  expect(sum([1, 2, 3])).toBe(6);
});
`,
    },
    hidden: {
      kind: "bun",
      file: "__hidden__.test.ts",
      content: `import { test, expect } from "bun:test";
import { clamp } from "./src/math.ts";

test("clamp", () => {
  expect(clamp(5, 0, 10)).toBe(5);
  expect(clamp(-5, 0, 10)).toBe(0);
  expect(clamp(15, 0, 10)).toBe(10);
  expect(clamp(0, 0, 10)).toBe(0);
  expect(clamp(10, 0, 10)).toBe(10);
});
`,
    },
  },
  {
    id: "ts-unique",
    tier: "T1",
    visible: false,
    prompt: "Add an exported function `unique<T>(arr: T[]): T[]` to src/arrays.ts that removes duplicates while preserving the first-seen order.",
    files: {
      "package.json": pkg(false),
      "src/arrays.ts": `export function last<T>(arr: T[]): T | undefined {
  return arr[arr.length - 1];
}
`,
    },
    hidden: {
      kind: "bun",
      file: "__hidden__.test.ts",
      content: `import { test, expect } from "bun:test";
import { unique } from "./src/arrays.ts";

test("unique preserves first-seen order", () => {
  expect(unique([3, 1, 3, 2, 1])).toEqual([3, 1, 2]);
  expect(unique([])).toEqual([]);
  expect(unique(["a", "a"])).toEqual(["a"]);
});
`,
    },
  },
  {
    id: "ts-rename-export",
    tier: "T1",
    visible: true,
    prompt: "Rename the exported function `fmtDate` in src/dates.ts to `formatDate`, and update every usage in the project. Do not keep a `fmtDate` alias.",
    files: {
      "package.json": pkg(true),
      "src/dates.ts": `export function fmtDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}
`,
      "src/report.ts": `import { fmtDate } from "./dates.ts";

export function reportLine(name: string, when: Date): string {
  return name + " @ " + fmtDate(when);
}
`,
      "tests/basic.test.ts": `import { test, expect } from "bun:test";
import { reportLine } from "../src/report.ts";

test("report line", () => {
  expect(reportLine("x", new Date(2026, 0, 5))).toBe("x @ 2026-01-05");
});
`,
    },
    hidden: {
      kind: "bun",
      file: "__hidden__.test.ts",
      content: `import { test, expect } from "bun:test";
import { formatDate } from "./src/dates.ts";
import { reportLine } from "./src/report.ts";
import * as dates from "./src/dates.ts";

test("renamed export works and old name is gone", () => {
  expect(formatDate(new Date(2026, 5, 11))).toBe("2026-06-11");
  expect((dates as any).fmtDate).toBeUndefined();
  expect(reportLine("a", new Date(2026, 0, 1))).toBe("a @ 2026-01-01");
});
`,
    },
  },
  {
    id: "ts-truncate-default",
    tier: "T1",
    visible: false,
    prompt: "In src/text.ts, change the default `max` of `truncate` from 80 to 100, and make sure the ellipsis is only added when the input was actually longer than max.",
    files: {
      "package.json": pkg(false),
      "src/text.ts": `/** Truncate s to max characters, appending an ellipsis. */
export function truncate(s: string, max = 80): string {
  return s.slice(0, max) + "…";
}
`,
    },
    hidden: {
      kind: "bun",
      file: "__hidden__.test.ts",
      content: `import { test, expect } from "bun:test";
import { truncate } from "./src/text.ts";

test("new default and conditional ellipsis", () => {
  const s99 = "a".repeat(99);
  expect(truncate(s99)).toBe(s99); // under the new 100 default → untouched
  const s101 = "a".repeat(101);
  expect(truncate(s101)).toBe("a".repeat(100) + "…");
  expect(truncate("short")).toBe("short");
});
`,
    },
  },
  {
    id: "ts-chunk",
    tier: "T1",
    visible: true,
    prompt: "Add an exported function `chunk<T>(arr: T[], size: number): T[][]` to src/arrays.ts that splits the array into consecutive chunks of `size` (the last chunk may be shorter). Throw an Error when size is not a positive integer.",
    files: {
      "package.json": pkg(true),
      "src/arrays.ts": `export function last<T>(arr: T[]): T | undefined {
  return arr[arr.length - 1];
}
`,
      "tests/basic.test.ts": `import { test, expect } from "bun:test";
import { last } from "../src/arrays.ts";

test("last still works", () => {
  expect(last([1, 2])).toBe(2);
});
`,
    },
    hidden: {
      kind: "bun",
      file: "__hidden__.test.ts",
      content: `import { test, expect } from "bun:test";
import { chunk } from "./src/arrays.ts";

test("chunking", () => {
  expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  expect(chunk([], 3)).toEqual([]);
  expect(() => chunk([1], 0)).toThrow();
  expect(() => chunk([1], 1.5)).toThrow();
});
`,
    },
  },

  // ── T2: medium ──────────────────────────────────────────────────────────
  {
    id: "ts-paginate-offbyone",
    tier: "T2",
    visible: true,
    prompt: "The `paginate` function in src/paginate.ts drops the last partial page (e.g. 5 items with pageSize 2 yields 2 pages instead of 3). Fix it so every item appears exactly once and `bun test` passes.",
    files: {
      "package.json": pkg(true),
      "src/paginate.ts": `export function paginate<T>(items: T[], pageSize: number): T[][] {
  const pages: T[][] = [];
  const n = Math.floor(items.length / pageSize); // BUG: drops the partial tail
  for (let i = 0; i < n; i++) pages.push(items.slice(i * pageSize, (i + 1) * pageSize));
  return pages;
}
`,
      "tests/basic.test.ts": `import { test, expect } from "bun:test";
import { paginate } from "../src/paginate.ts";

test("partial last page is kept", () => {
  expect(paginate([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
});
`,
    },
    hidden: {
      kind: "bun",
      file: "__hidden__.test.ts",
      content: `import { test, expect } from "bun:test";
import { paginate } from "./src/paginate.ts";

test("pagination edge cases", () => {
  expect(paginate([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  expect(paginate([1, 2], 2)).toEqual([[1, 2]]);
  expect(paginate([], 3)).toEqual([]);
  expect(paginate([1], 10)).toEqual([[1]]);
});
`,
    },
  },
  {
    id: "ts-days-between",
    tier: "T2",
    visible: false,
    prompt: "`daysBetween(a, b)` in src/dates.ts should return the whole number of days from a to b — negative when b is before a, and symmetric: daysBetween(a, b) === -daysBetween(b, a). It currently uses Math.floor, which is wrong for negative differences. Fix it.",
    files: {
      "package.json": pkg(false),
      "src/dates.ts": `const DAY = 86_400_000;

export function daysBetween(a: Date, b: Date): number {
  return Math.floor((b.getTime() - a.getTime()) / DAY); // BUG: floor breaks negatives
}
`,
    },
    hidden: {
      kind: "bun",
      file: "__hidden__.test.ts",
      content: `import { test, expect } from "bun:test";
import { daysBetween } from "./src/dates.ts";

test("symmetric day difference", () => {
  const a = new Date(Date.UTC(2026, 0, 1));
  const b = new Date(Date.UTC(2026, 0, 4));
  expect(daysBetween(a, b)).toBe(3);
  expect(daysBetween(b, a)).toBe(-3);
  const half = new Date(Date.UTC(2026, 0, 1, 12));
  expect(daysBetween(a, half)).toBe(0);
  expect(daysBetween(half, a)).toBe(0);
});
`,
    },
  },
  {
    id: "ts-csv-quotes",
    tier: "T2",
    visible: true,
    prompt: "The CSV parser in src/csv.ts splits naively on commas, so quoted fields break. Make `parseCsvLine` support double-quoted fields that may contain commas, and escaped quotes written as two double quotes (\"\") inside a quoted field. Unquoted fields keep current behavior. `bun test` should pass.",
    files: {
      "package.json": pkg(true),
      "src/csv.ts": `export function parseCsvLine(line: string): string[] {
  return line.split(","); // BUG: ignores quoting entirely
}
`,
      "tests/basic.test.ts": `import { test, expect } from "bun:test";
import { parseCsvLine } from "../src/csv.ts";

test("quoted field with a comma", () => {
  expect(parseCsvLine('a,"b,c",d')).toEqual(["a", "b,c", "d"]);
});
`,
    },
    hidden: {
      kind: "bun",
      file: "__hidden__.test.ts",
      content: `import { test, expect } from "bun:test";
import { parseCsvLine } from "./src/csv.ts";

test("quoting rules", () => {
  expect(parseCsvLine("a,b,c")).toEqual(["a", "b", "c"]);
  expect(parseCsvLine('a,"b,c",d')).toEqual(["a", "b,c", "d"]);
  expect(parseCsvLine('"say ""hi"", ok",x')).toEqual(['say "hi", ok', "x"]);
  expect(parseCsvLine('""')).toEqual([""]);
  expect(parseCsvLine("")).toEqual([""]);
});
`,
    },
  },
  {
    id: "ts-cart-order",
    tier: "T2",
    visible: true,
    prompt: "In src/cart.ts, `total` is wrong in two ways: (1) the percentage discount must apply to the subtotal BEFORE tax, then tax is added on the discounted amount; (2) add a bulk rule — when the cart holds 10 or more total units, an extra 10% discount applies (after the regular discount, before tax). Round to 2 decimals at the end only. Make `bun test` pass.",
    files: {
      "package.json": pkg(true),
      "src/cart.ts": `export interface Item { price: number; qty: number }

export function total(items: Item[], discountPct: number, taxPct: number): number {
  const subtotal = items.reduce((s, it) => s + it.price * it.qty, 0);
  const taxed = subtotal * (1 + taxPct / 100); // BUG: tax before discount, no bulk rule
  const discounted = taxed * (1 - discountPct / 100);
  return Math.round(discounted * 100) / 100;
}
`,
      "tests/basic.test.ts": `import { test, expect } from "bun:test";
import { total } from "../src/cart.ts";

test("discount before tax", () => {
  // 100 → 10% discount → 90 → 10% tax → 99
  expect(total([{ price: 100, qty: 1 }], 10, 10)).toBe(99);
});

test("bulk rule at 10 units", () => {
  // 10×10=100 → 0% discount → bulk 10% → 90 → 10% tax → 99
  expect(total([{ price: 10, qty: 10 }], 0, 10)).toBe(99);
});
`,
    },
    hidden: {
      kind: "bun",
      file: "__hidden__.test.ts",
      content: `import { test, expect } from "bun:test";
import { total } from "./src/cart.ts";

test("order of operations", () => {
  expect(total([{ price: 100, qty: 1 }], 10, 10)).toBe(99);
  expect(total([{ price: 10, qty: 10 }], 0, 10)).toBe(99);
  // both discounts stack: 200 → 10% → 180 → bulk 10% → 162 → 5% tax → 170.1
  expect(total([{ price: 20, qty: 10 }], 10, 5)).toBe(170.1);
  // 9 units: no bulk
  expect(total([{ price: 10, qty: 9 }], 0, 0)).toBe(90);
  expect(total([], 50, 50)).toBe(0);
});
`,
    },
  },
  {
    id: "ts-lru",
    tier: "T2",
    visible: false,
    prompt: "Create src/lru.ts exporting a class `LRUCache<K, V>` with `constructor(capacity: number)`, `get(key): V | undefined`, and `set(key, value): void`. When the cache exceeds capacity, evict the least-recently-used entry. Both get and set count as a use.",
    files: {
      "package.json": pkg(false),
      "src/README.md": "utility modules live here\n",
    },
    hidden: {
      kind: "bun",
      file: "__hidden__.test.ts",
      content: `import { test, expect } from "bun:test";
import { LRUCache } from "./src/lru.ts";

test("evicts least-recently-used", () => {
  const c = new LRUCache<string, number>(2);
  c.set("a", 1);
  c.set("b", 2);
  expect(c.get("a")).toBe(1); // touch a → b is now LRU
  c.set("c", 3); // evicts b
  expect(c.get("b")).toBeUndefined();
  expect(c.get("a")).toBe(1);
  expect(c.get("c")).toBe(3);
});

test("set updates recency and value", () => {
  const c = new LRUCache<string, number>(2);
  c.set("a", 1);
  c.set("b", 2);
  c.set("a", 9); // touch a → b is LRU
  c.set("c", 3); // evicts b
  expect(c.get("a")).toBe(9);
  expect(c.get("b")).toBeUndefined();
});
`,
    },
  },
  {
    id: "ts-retry-backoff",
    tier: "T2",
    visible: true,
    prompt: "Create src/retry.ts exporting `retry<T>(fn: () => Promise<T>, attempts: number, baseDelayMs: number): Promise<T>`. It retries a rejecting fn up to `attempts` total tries, waiting baseDelayMs, then 2×, then 4× (exponential) between tries, and rethrows the LAST error when all tries fail. `bun test` should pass.",
    files: {
      "package.json": pkg(true),
      "tests/basic.test.ts": `import { test, expect } from "bun:test";
import { retry } from "../src/retry.ts";

test("succeeds on a later attempt", async () => {
  let n = 0;
  const r = await retry(async () => {
    n++;
    if (n < 3) throw new Error("flaky " + n);
    return "ok";
  }, 3, 1);
  expect(r).toBe("ok");
  expect(n).toBe(3);
});
`,
    },
    hidden: {
      kind: "bun",
      file: "__hidden__.test.ts",
      content: `import { test, expect } from "bun:test";
import { retry } from "./src/retry.ts";

test("rethrows the LAST error after exhausting attempts", async () => {
  let n = 0;
  await expect(retry(async () => { n++; throw new Error("err" + n); }, 3, 1)).rejects.toThrow("err3");
  expect(n).toBe(3);
});

test("no retry needed", async () => {
  let n = 0;
  expect(await retry(async () => { n++; return 7; }, 5, 1)).toBe(7);
  expect(n).toBe(1);
});
`,
    },
  },
  {
    id: "ts-stable-sort",
    tier: "T2",
    visible: false,
    prompt: "`sortUsers` in src/users.ts must sort by age ascending, and break ties by name (case-insensitive, ascending). It currently sorts by age only. Fix it without mutating the input array.",
    files: {
      "package.json": pkg(false),
      "src/users.ts": `export interface User { name: string; age: number }

export function sortUsers(users: User[]): User[] {
  return users.sort((a, b) => a.age - b.age); // BUG: no tiebreak, mutates input
}
`,
    },
    hidden: {
      kind: "bun",
      file: "__hidden__.test.ts",
      content: `import { test, expect } from "bun:test";
import { sortUsers } from "./src/users.ts";

test("age then case-insensitive name; input untouched", () => {
  const input = [
    { name: "bob", age: 30 },
    { name: "Alice", age: 30 },
    { name: "carol", age: 20 },
  ];
  const snapshot = JSON.parse(JSON.stringify(input));
  const out = sortUsers(input);
  expect(out.map((u) => u.name)).toEqual(["carol", "Alice", "bob"]);
  expect(input).toEqual(snapshot);
});
`,
    },
  },
  {
    id: "ts-semver",
    tier: "T2",
    visible: true,
    prompt: "`compareVersions(a, b)` in src/semver.ts compares dotted numeric versions ('1.2.3') and should return -1, 0, or 1. It currently compares lexically, so '10.0.0' sorts before '9.0.0'. Fix it to compare numerically, treating missing segments as 0 (so '1.2' equals '1.2.0'). `bun test` should pass.",
    files: {
      "package.json": pkg(true),
      "src/semver.ts": `export function compareVersions(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0; // BUG: lexical comparison
}
`,
      "tests/basic.test.ts": `import { test, expect } from "bun:test";
import { compareVersions } from "../src/semver.ts";

test("numeric segments", () => {
  expect(compareVersions("10.0.0", "9.0.0")).toBe(1);
});
`,
    },
    hidden: {
      kind: "bun",
      file: "__hidden__.test.ts",
      content: `import { test, expect } from "bun:test";
import { compareVersions } from "./src/semver.ts";

test("numeric compare with missing segments", () => {
  expect(compareVersions("10.0.0", "9.0.0")).toBe(1);
  expect(compareVersions("1.2", "1.2.0")).toBe(0);
  expect(compareVersions("1.2.1", "1.10.0")).toBe(-1);
  expect(compareVersions("2.0.0", "2.0.0")).toBe(0);
  expect(compareVersions("0.9", "1")).toBe(-1);
});
`,
    },
  },

  // ── T3: hard ────────────────────────────────────────────────────────────
  {
    id: "ts-storage-roundtrip",
    tier: "T3",
    visible: true,
    prompt: "src/storage.ts serializes records to a string store, but Date values come back as plain strings after a save/load roundtrip. Refactor the serialization into an exported pair `encode(value: unknown): string` / `decode(s: string): unknown` in a new src/codec.ts that round-trips Date objects (any nesting depth) — and use it from Storage. Keep the existing Storage API (`save`, `load`) working. `bun test` should pass.",
    files: {
      "package.json": pkg(true),
      "src/storage.ts": `const store = new Map<string, string>();

export class Storage {
  save(key: string, value: unknown): void {
    store.set(key, JSON.stringify(value)); // BUG: dates stringify and never revive
  }
  load<T = unknown>(key: string): T | undefined {
    const s = store.get(key);
    return s === undefined ? undefined : (JSON.parse(s) as T);
  }
}
`,
      "tests/basic.test.ts": `import { test, expect } from "bun:test";
import { Storage } from "../src/storage.ts";

test("dates survive a roundtrip", () => {
  const s = new Storage();
  const when = new Date(2026, 5, 11, 9, 30);
  s.save("k", { nested: { when }, list: [when] });
  const out = s.load<any>("k");
  expect(out.nested.when instanceof Date).toBe(true);
  expect(out.nested.when.getTime()).toBe(when.getTime());
  expect(out.list[0] instanceof Date).toBe(true);
});
`,
    },
    hidden: {
      kind: "bun",
      file: "__hidden__.test.ts",
      content: `import { test, expect } from "bun:test";
import { Storage } from "./src/storage.ts";
import { encode, decode } from "./src/codec.ts";

test("codec is the extracted seam and round-trips dates deeply", () => {
  const when = new Date(2024, 1, 2, 3, 4, 5);
  const v = { a: [{ b: when }], plain: "2024-02-02", n: 5 };
  const out = decode(encode(v)) as any;
  expect(out.a[0].b instanceof Date).toBe(true);
  expect(out.a[0].b.getTime()).toBe(when.getTime());
  expect(out.plain).toBe("2024-02-02"); // a plain string that LOOKS like a date stays a string
  expect(out.n).toBe(5);
});

test("storage uses the codec", () => {
  const s = new Storage();
  const when = new Date(2026, 0, 1);
  s.save("k", { when });
  expect((s.load<any>("k")).when instanceof Date).toBe(true);
});
`,
    },
  },
  {
    id: "ts-event-emitter",
    tier: "T3",
    visible: false,
    prompt: "Create src/emitter.ts exporting a class `Emitter` with `on(event: string, fn: (...args: any[]) => void): () => void` (returns an unsubscribe), `once(event, fn)`, `off(event, fn)`, and `emit(event, ...args)`. Handlers removed DURING an emit (including by the handler itself or by once) must not break iteration or skip other handlers of the same emit.",
    files: {
      "package.json": pkg(false),
      "src/README.md": "utility modules live here\n",
    },
    hidden: {
      kind: "bun",
      file: "__hidden__.test.ts",
      content: `import { test, expect } from "bun:test";
import { Emitter } from "./src/emitter.ts";

test("on/off/once basics", () => {
  const e = new Emitter();
  const seen: string[] = [];
  const un = e.on("x", (v) => seen.push("a" + v));
  e.once("x", (v) => seen.push("b" + v));
  e.emit("x", 1);
  e.emit("x", 2);
  un();
  e.emit("x", 3);
  expect(seen).toEqual(["a1", "b1", "a2"]);
});

test("removal during emit neither breaks nor skips", () => {
  const e = new Emitter();
  const seen: string[] = [];
  const h1 = () => { seen.push("h1"); e.off("x", h1); };
  const h2 = () => seen.push("h2");
  e.on("x", h1);
  e.on("x", h2);
  e.emit("x"); // h1 removes itself mid-emit; h2 must still run
  e.emit("x");
  expect(seen).toEqual(["h1", "h2", "h2"]);
});
`,
    },
  },
  {
    id: "ts-interval-merge",
    tier: "T3",
    visible: true,
    prompt: "Implement `mergeIntervals(intervals: [number, number][]): [number, number][]` in src/intervals.ts. Input may be unsorted and may contain negative numbers; intervals that overlap OR touch (e.g. [1,3] and [3,5]) merge into one. Return the merged list sorted by start. Do not mutate the input. `bun test` should pass.",
    files: {
      "package.json": pkg(true),
      "src/intervals.ts": `export function mergeIntervals(intervals: [number, number][]): [number, number][] {
  return intervals; // TODO: implement
}
`,
      "tests/basic.test.ts": `import { test, expect } from "bun:test";
import { mergeIntervals } from "../src/intervals.ts";

test("overlap and touch", () => {
  expect(mergeIntervals([[1, 3], [3, 5], [7, 8]])).toEqual([[1, 5], [7, 8]]);
});
`,
    },
    hidden: {
      kind: "bun",
      file: "__hidden__.test.ts",
      content: `import { test, expect } from "bun:test";
import { mergeIntervals } from "./src/intervals.ts";

test("unsorted, negative, nested, untouched input", () => {
  const input: [number, number][] = [[5, 6], [-3, -1], [-2, 4], [10, 12]];
  const snapshot = JSON.parse(JSON.stringify(input));
  expect(mergeIntervals(input)).toEqual([[-3, 6], [10, 12]]);
  expect(input).toEqual(snapshot);
  expect(mergeIntervals([])).toEqual([]);
  expect(mergeIntervals([[1, 10], [2, 3]])).toEqual([[1, 10]]);
});
`,
    },
  },
  {
    id: "ts-debounce",
    tier: "T3",
    visible: false,
    prompt: "Create src/debounce.ts exporting `debounce<F extends (...args: any[]) => void>(fn: F, waitMs: number, opts?: { leading?: boolean }): F & { cancel(): void }`. Trailing-edge by default: fn runs waitMs after the LAST call, with the last call's arguments. With leading: true it also fires immediately on the first call of a burst (and must not fire twice for a single-call burst). cancel() drops any pending trailing call.",
    files: {
      "package.json": pkg(false),
      "src/README.md": "utility modules live here\n",
    },
    hidden: {
      kind: "bun",
      file: "__hidden__.test.ts",
      content: `import { test, expect } from "bun:test";
import { debounce } from "./src/debounce.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("trailing edge with last args", async () => {
  const seen: number[] = [];
  const d = debounce((n: number) => seen.push(n), 30);
  d(1); d(2); d(3);
  await sleep(60);
  expect(seen).toEqual([3]);
});

test("leading fires once for a single-call burst", async () => {
  const seen: number[] = [];
  const d = debounce((n: number) => seen.push(n), 30, { leading: true });
  d(1);
  await sleep(60);
  expect(seen).toEqual([1]);
  d(2); d(3);
  await sleep(60);
  expect(seen).toEqual([1, 2, 3]); // leading 2, trailing 3
});

test("cancel drops the pending call", async () => {
  const seen: number[] = [];
  const d = debounce((n: number) => seen.push(n), 30);
  d(1);
  d.cancel();
  await sleep(60);
  expect(seen).toEqual([]);
});
`,
    },
  },
  {
    id: "ts-md-table",
    tier: "T3",
    visible: true,
    prompt: "Implement `mdTable(headers: string[], rows: string[][]): string` in src/md.ts producing a GitHub-flavored markdown table where every column is padded so all pipes line up: each cell is left-aligned and padded to its column's widest content (headers count). Pipe characters inside cells must be escaped as \\\\|. The separator row uses dashes matching each column width. Lines are joined with \\n and there is no trailing newline. `bun test` should pass.",
    files: {
      "package.json": pkg(true),
      "src/md.ts": `export function mdTable(headers: string[], rows: string[][]): string {
  return ""; // TODO: implement
}
`,
      "tests/basic.test.ts": `import { test, expect } from "bun:test";
import { mdTable } from "../src/md.ts";

test("aligned columns", () => {
  expect(mdTable(["name", "n"], [["alice", "1"], ["bo", "22"]])).toBe(
    "| name  | n  |\\n| ----- | -- |\\n| alice | 1  |\\n| bo    | 22 |",
  );
});
`,
    },
    hidden: {
      kind: "bun",
      file: "__hidden__.test.ts",
      content: `import { test, expect } from "bun:test";
import { mdTable } from "./src/md.ts";

test("alignment, escaping, width from headers", () => {
  expect(mdTable(["name", "n"], [["alice", "1"], ["bo", "22"]])).toBe(
    "| name  | n  |\\n| ----- | -- |\\n| alice | 1  |\\n| bo    | 22 |",
  );
  // header wider than any cell
  expect(mdTable(["header", "x"], [["a", "b"]])).toBe(
    "| header | x |\\n| ------ | - |\\n| a      | b |",
  );
  // pipes escape; escaped pipe counts at its rendered width
  expect(mdTable(["c"], [["a|b"]])).toBe(
    "| c    |\\n| ---- |\\n| a\\\\|b |",
  );
});
`,
    },
  },
  {
    id: "ts-path-router",
    tier: "T3",
    visible: false,
    prompt: "src/router.ts matches URL paths against patterns like '/users/:id/posts/:postId'. The bug: a ':param' currently matches across slashes ('/users/1/posts/2' wrongly matches '/users/:id'), because segments aren't compared one by one. Fix `matchPath` to (1) match segment-by-segment, (2) tolerate ONE optional trailing slash on the path, and (3) return null on length mismatch. Keep returning the captured params object on a match.",
    files: {
      "package.json": pkg(false),
      "src/router.ts": `export function matchPath(pattern: string, path: string): Record<string, string> | null {
  // BUG: regex-based, params match across slashes and trailing slash breaks it
  const rx = new RegExp("^" + pattern.replace(/:([a-zA-Z]+)/g, "(?<$1>.+)") + "$");
  const m = path.match(rx);
  return m ? { ...(m.groups ?? {}) } : null;
}
`,
    },
    hidden: {
      kind: "bun",
      file: "__hidden__.test.ts",
      content: `import { test, expect } from "bun:test";
import { matchPath } from "./src/router.ts";

test("segment-wise matching", () => {
  expect(matchPath("/users/:id", "/users/42")).toEqual({ id: "42" });
  expect(matchPath("/users/:id", "/users/1/posts/2")).toBeNull(); // no cross-slash match
  expect(matchPath("/users/:id/posts/:postId", "/users/1/posts/2")).toEqual({ id: "1", postId: "2" });
  expect(matchPath("/users/:id", "/users/42/")).toEqual({ id: "42" }); // one trailing slash ok
  expect(matchPath("/users/:id", "/users")).toBeNull();
  expect(matchPath("/about", "/about")).toEqual({});
});
`,
    },
  },
];
