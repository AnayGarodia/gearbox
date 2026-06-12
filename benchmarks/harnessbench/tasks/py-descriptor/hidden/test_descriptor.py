import sys, os; sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from temperature import Temperature

def test_basic_conversion():
    t = Temperature(100)
    assert t.fahrenheit == 212.0, f"expected 212, got {t.fahrenheit}"

def test_zero():
    t = Temperature(0)
    assert t.fahrenheit == 32.0

def test_instances_are_independent():
    a = Temperature(0)
    b = Temperature(100)
    # BUG: with class-level storage, changing b changes a
    assert a.celsius == 0, f"a was mutated to {a.celsius}"
    assert b.celsius == 100

def test_mutation_does_not_affect_other_instances():
    a = Temperature(20)
    b = Temperature(30)
    a.celsius = 25
    assert b.celsius == 30, f"b.celsius changed to {b.celsius}"

def test_multiple_instances_conversion():
    temps = [Temperature(c) for c in [0, 20, 37, 100]]
    expected = [32, 68, 98.6, 212]
    for t, e in zip(temps, expected):
        assert abs(t.fahrenheit - e) < 0.01, f"{t.celsius}°C should be {e}°F not {t.fahrenheit}°F"

if __name__ == "__main__":
    test_basic_conversion()
    test_zero()
    test_instances_are_independent()
    test_mutation_does_not_affect_other_instances()
    test_multiple_instances_conversion()
    print("All tests passed")
