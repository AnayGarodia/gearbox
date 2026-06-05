def add(a, b): return a + b
def sub(a, b): return a - b
def mul(a, b): return a * b
def div(a, b): return a / b
def mod(a, b): return a % b
def power(a, b): return a ** b
def negate(a): return -a
def absolute(a): return abs(a)
def increment(a): return a + 1
def decrement(a): return a - 1
def square(a): return a * a
def cube(a): return a * a * a
def half(a): return a / 2
def double(a): return a * 2
def is_even(a): return a % 2 == 0
def is_odd(a): return a % 2 != 0
def is_positive(a): return a > 0
def is_negative(a): return a < 0
def is_zero(a): return a == 0
def sign(a): return 0 if a == 0 else (1 if a > 0 else -1)
def clamp(a, lo, hi): return max(lo, min(hi, a))
def minimum(a, b): return a if a < b else b
def maximum(a, b): return a if a > b else b
def average(a, b): return (a + b) / 2
def digits(a): return len(str(abs(a)))
def reverse_int(a): return int(str(abs(a))[::-1]) * sign(a)
def digit_sum(a): return sum(int(d) for d in str(abs(a)))
def factorial(n): return 1 if n <= 1 else n * factorial(n - 1)
def gcd(a, b): return a if b == 0 else gcd(b, a % b)
def lcm(a, b): return abs(a * b) // gcd(a, b)
