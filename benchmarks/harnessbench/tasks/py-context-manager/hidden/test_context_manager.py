import sys, os; sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from resource import ManagedResource

def test_enter_opens_and_returns_self():
    r = ManagedResource()
    result = r.__enter__()
    assert r.opened, "open() not called"
    assert result is r, "__enter__ should return self"

def test_exit_closes():
    r = ManagedResource()
    r.__enter__()
    r.__exit__(None, None, None)
    assert r.closed, "close() not called"

def test_with_statement():
    r = ManagedResource()
    with r as resource:
        assert resource is r
        _ = resource.read()
    assert r.closed

def test_closes_on_exception():
    r = ManagedResource()
    try:
        with r:
            raise ValueError("boom")
    except ValueError:
        pass
    assert r.closed, "close() must be called even on exception"

def test_does_not_suppress_exception():
    r = ManagedResource()
    try:
        with r:
            raise RuntimeError("should propagate")
        assert False, "exception should have propagated"
    except RuntimeError:
        pass

if __name__ == "__main__":
    test_enter_opens_and_returns_self()
    test_exit_closes()
    test_with_statement()
    test_closes_on_exception()
    test_does_not_suppress_exception()
    print("All tests passed")
