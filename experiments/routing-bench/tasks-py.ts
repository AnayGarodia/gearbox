// Python fixture tasks — 10 mini-workspaces judged with stdlib unittest (no
// pip installs). All are hidden-only: the workspaces ship no test command, so
// the agent routes at the none verifier tier — exactly the territory the
// selfverify cascade and the expected-cost caution branch are built for.
import type { BenchTask } from "./types.ts";

export const PY_TASKS: BenchTask[] = [
  // ── T1 ──────────────────────────────────────────────────────────────────
  {
    id: "py-snake-case",
    tier: "T1",
    visible: false,
    prompt: "Add a function `snake_case(s)` to textutil.py that converts camelCase or PascalCase to snake_case (e.g. 'parseHTTPResponse' → 'parse_http_response'; consecutive capitals stay one word). Already-snake_case input is returned unchanged.",
    files: {
      "textutil.py": `def shout(s):
    return s.upper() + "!"
`,
    },
    hidden: {
      kind: "python",
      file: "__hidden_test.py",
      content: `import unittest
from textutil import snake_case

class T(unittest.TestCase):
    def test_basic(self):
        self.assertEqual(snake_case("camelCase"), "camel_case")
        self.assertEqual(snake_case("PascalCase"), "pascal_case")
        self.assertEqual(snake_case("parseHTTPResponse"), "parse_http_response")
        self.assertEqual(snake_case("already_snake"), "already_snake")

if __name__ == "__main__":
    unittest.main()
`,
    },
  },
  {
    id: "py-flatten",
    tier: "T1",
    visible: false,
    prompt: "Add a function `flatten(nested)` to listutil.py that deep-flattens arbitrarily nested lists into a single flat list, preserving order. Non-list elements (including strings and tuples) are kept as-is, never iterated into.",
    files: {
      "listutil.py": `def first(xs, default=None):
    return xs[0] if xs else default
`,
    },
    hidden: {
      kind: "python",
      file: "__hidden_test.py",
      content: `import unittest
from listutil import flatten

class T(unittest.TestCase):
    def test_flatten(self):
        self.assertEqual(flatten([1, [2, [3, [4]]], 5]), [1, 2, 3, 4, 5])
        self.assertEqual(flatten([]), [])
        self.assertEqual(flatten(["ab", ["cd"]]), ["ab", "cd"])  # strings stay whole
        self.assertEqual(flatten([(1, 2), [3]]), [(1, 2), 3])    # tuples stay whole

if __name__ == "__main__":
    unittest.main()
`,
    },
  },

  // ── T2 ──────────────────────────────────────────────────────────────────
  {
    id: "py-median",
    tier: "T2",
    visible: false,
    prompt: "stats.py has a bug: `median` returns the lower-middle element for even-length lists instead of the mean of the two middles. Fix it (don't mutate the input; it must work on unsorted lists). An empty list should raise ValueError.",
    files: {
      "stats.py": `def median(xs):
    s = sorted(xs)
    return s[len(s) // 2]  # BUG: wrong for even lengths, no empty check
`,
    },
    hidden: {
      kind: "python",
      file: "__hidden_test.py",
      content: `import unittest
from stats import median

class T(unittest.TestCase):
    def test_median(self):
        self.assertEqual(median([3, 1, 2]), 2)
        self.assertEqual(median([4, 1, 2, 3]), 2.5)
        self.assertEqual(median([5]), 5)
        xs = [2, 1]
        self.assertEqual(median(xs), 1.5)
        self.assertEqual(xs, [2, 1])  # input untouched
        with self.assertRaises(ValueError):
            median([])

if __name__ == "__main__":
    unittest.main()
`,
    },
  },
  {
    id: "py-ledger",
    tier: "T2",
    visible: false,
    prompt: "ledger.py tracks a balance via apply(). Two fixes: (1) refunds (negative amounts) must be allowed and reduce the balance; (2) a withdrawal that would push the balance below zero must raise ValueError('insufficient funds') and leave the balance unchanged. Deposits use apply(amount) with positive amounts, withdrawals use withdraw(amount).",
    files: {
      "ledger.py": `class Ledger:
    def __init__(self):
        self.balance = 0

    def apply(self, amount):
        if amount < 0:
            return  # BUG: refunds silently ignored
        self.balance += amount

    def withdraw(self, amount):
        self.balance -= amount  # BUG: overdraft allowed
`,
    },
    hidden: {
      kind: "python",
      file: "__hidden_test.py",
      content: `import unittest
from ledger import Ledger

class T(unittest.TestCase):
    def test_refunds_and_overdraft(self):
        l = Ledger()
        l.apply(100)
        l.apply(-30)  # refund
        self.assertEqual(l.balance, 70)
        l.withdraw(50)
        self.assertEqual(l.balance, 20)
        with self.assertRaises(ValueError):
            l.withdraw(21)
        self.assertEqual(l.balance, 20)  # unchanged after the failed withdrawal

if __name__ == "__main__":
    unittest.main()
`,
    },
  },
  {
    id: "py-roman",
    tier: "T2",
    visible: false,
    prompt: "Add a function `int_to_roman(n)` to roman.py for 1 ≤ n ≤ 3999 using standard subtractive notation (4 → 'IV', 9 → 'IX', 40 → 'XL', 90 → 'XC', 400 → 'CD', 900 → 'CM'). Out-of-range input raises ValueError.",
    files: {
      "roman.py": `# roman numeral helpers
`,
    },
    hidden: {
      kind: "python",
      file: "__hidden_test.py",
      content: `import unittest
from roman import int_to_roman

class T(unittest.TestCase):
    def test_roman(self):
        self.assertEqual(int_to_roman(1), "I")
        self.assertEqual(int_to_roman(4), "IV")
        self.assertEqual(int_to_roman(9), "IX")
        self.assertEqual(int_to_roman(14), "XIV")
        self.assertEqual(int_to_roman(90), "XC")
        self.assertEqual(int_to_roman(444), "CDXLIV")
        self.assertEqual(int_to_roman(1994), "MCMXCIV")
        self.assertEqual(int_to_roman(3999), "MMMCMXCIX")
        for bad in (0, 4000, -5):
            with self.assertRaises(ValueError):
                int_to_roman(bad)

if __name__ == "__main__":
    unittest.main()
`,
    },
  },
  {
    id: "py-memoize",
    tier: "T2",
    visible: false,
    prompt: "cachetools.py has a memoize decorator that crashes on keyword arguments (TypeError: unhashable) and conflates calls like f(1, b=2) with f(1). Fix it so positional and keyword arguments are cached correctly and distinctly; the wrapped function's calls are only executed once per distinct argument set.",
    files: {
      "cachetools.py": `def memoize(fn):
    cache = {}
    def wrapped(*args, **kwargs):
        key = (args, kwargs)  # BUG: dict is unhashable
        if key not in cache:
            cache[key] = fn(*args, **kwargs)
        return cache[key]
    return wrapped
`,
    },
    hidden: {
      kind: "python",
      file: "__hidden_test.py",
      content: `import unittest
from cachetools import memoize

class T(unittest.TestCase):
    def test_kwargs(self):
        calls = []
        @memoize
        def f(a, b=0):
            calls.append((a, b))
            return a + b
        self.assertEqual(f(1, b=2), 3)
        self.assertEqual(f(1, b=2), 3)
        self.assertEqual(f(1), 1)
        self.assertEqual(f(1, b=3), 4)
        self.assertEqual(len(calls), 3)  # three distinct argument sets

if __name__ == "__main__":
    unittest.main()
`,
    },
  },
  {
    id: "py-csv-sum",
    tier: "T2",
    visible: false,
    prompt: "csvsum.py: `sum_column(lines, col, has_header=True)` sums a numeric column from CSV lines. Bugs: it always skips the first line even when has_header=False, and it crashes on empty lines (skip them instead). Fix both.",
    files: {
      "csvsum.py": `def sum_column(lines, col, has_header=True):
    total = 0.0
    for line in lines[1:]:  # BUG: always skips the first line
        parts = line.split(",")
        total += float(parts[col])  # BUG: empty lines crash
    return total
`,
    },
    hidden: {
      kind: "python",
      file: "__hidden_test.py",
      content: `import unittest
from csvsum import sum_column

class T(unittest.TestCase):
    def test_sum(self):
        with_header = ["n,amt", "a,1.5", "b,2.5"]
        self.assertEqual(sum_column(with_header, 1), 4.0)
        no_header = ["a,1.5", "b,2.5"]
        self.assertEqual(sum_column(no_header, 1, has_header=False), 4.0)
        messy = ["n,amt", "a,1", "", "b,2"]
        self.assertEqual(sum_column(messy, 1), 3.0)

if __name__ == "__main__":
    unittest.main()
`,
    },
  },

  // ── T3 ──────────────────────────────────────────────────────────────────
  {
    id: "py-intervals",
    tier: "T3",
    visible: false,
    prompt: "Implement `merge_intervals(intervals)` in intervals.py: given a list of (start, end) tuples, possibly unsorted with negative numbers, merge intervals that overlap or touch and return a list of tuples sorted by start. Do not mutate the input list.",
    files: {
      "intervals.py": `def merge_intervals(intervals):
    return intervals  # TODO: implement
`,
    },
    hidden: {
      kind: "python",
      file: "__hidden_test.py",
      content: `import unittest
from intervals import merge_intervals

class T(unittest.TestCase):
    def test_merge(self):
        inp = [(5, 6), (-3, -1), (-2, 4), (10, 12)]
        snapshot = list(inp)
        self.assertEqual(merge_intervals(inp), [(-3, 6), (10, 12)])
        self.assertEqual(inp, snapshot)
        self.assertEqual(merge_intervals([]), [])
        self.assertEqual(merge_intervals([(1, 3), (3, 5)]), [(1, 5)])
        self.assertEqual(merge_intervals([(1, 10), (2, 3)]), [(1, 10)])

if __name__ == "__main__":
    unittest.main()
`,
    },
  },
  {
    id: "py-rotate",
    tier: "T3",
    visible: false,
    prompt: "matrix.py: `rotate_cw(m)` should rotate an N×M matrix (list of equal-length rows) 90 degrees clockwise, returning a new M×N matrix. The current code only works for square matrices and mutates its input. Fix both: support non-square inputs and never mutate.",
    files: {
      "matrix.py": `def rotate_cw(m):
    n = len(m)
    for i in range(n):       # BUG: square-only in-place transpose
        for j in range(i, n):
            m[i][j], m[j][i] = m[j][i], m[i][j]
    for row in m:
        row.reverse()
    return m
`,
    },
    hidden: {
      kind: "python",
      file: "__hidden_test.py",
      content: `import unittest
from matrix import rotate_cw

class T(unittest.TestCase):
    def test_rotate(self):
        m = [[1, 2, 3], [4, 5, 6]]  # 2x3
        snapshot = [row[:] for row in m]
        self.assertEqual(rotate_cw(m), [[4, 1], [5, 2], [6, 3]])
        self.assertEqual(m, snapshot)  # not mutated
        self.assertEqual(rotate_cw([[1]]), [[1]])
        self.assertEqual(rotate_cw([[1, 2], [3, 4]]), [[3, 1], [4, 2]])

if __name__ == "__main__":
    unittest.main()
`,
    },
  },
  {
    id: "py-wordwrap",
    tier: "T3",
    visible: false,
    prompt: "Implement `wrap(text, width)` in wrap.py: greedy word wrap into a list of lines, each at most `width` characters. Words longer than `width` are hard-broken across lines at exactly `width`. Collapse runs of whitespace to single spaces first; an empty (or all-whitespace) text returns [].",
    files: {
      "wrap.py": `def wrap(text, width):
    return [text]  # TODO: implement
`,
    },
    hidden: {
      kind: "python",
      file: "__hidden_test.py",
      content: `import unittest
from wrap import wrap

class T(unittest.TestCase):
    def test_wrap(self):
        self.assertEqual(wrap("the quick brown fox", 10), ["the quick", "brown fox"])
        self.assertEqual(wrap("a  b   c", 5), ["a b c"])
        self.assertEqual(wrap("abcdefghij", 4), ["abcd", "efgh", "ij"])
        self.assertEqual(wrap("hi abcdefgh", 4), ["hi", "abcd", "efgh"])
        self.assertEqual(wrap("   ", 5), [])
        self.assertEqual(wrap("", 5), [])

if __name__ == "__main__":
    unittest.main()
`,
    },
  },
];
