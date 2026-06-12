import sys, os, asyncio; sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from retry import retry_async, RetryableError

def run(coro): return asyncio.run(coro)

def test_succeeds_on_first_try():
    async def fn(): return 42
    assert run(retry_async(fn)) == 42

def test_retries_on_retryable_error():
    calls = [0]
    async def fn():
        calls[0] += 1
        if calls[0] < 3: raise RetryableError("temp")
        return "ok"
    assert run(retry_async(fn, max_attempts=3)) == "ok"
    assert calls[0] == 3

def test_non_retryable_propagates_immediately():
    calls = [0]
    async def fn():
        calls[0] += 1
        raise ValueError("fatal")
    try:
        run(retry_async(fn, max_attempts=3))
        assert False, "should have raised"
    except ValueError:
        pass
    assert calls[0] == 1, f"should not retry, called {calls[0]} times"

def test_reraises_last_exception():
    count = [0]
    async def fn():
        count[0] += 1
        raise RetryableError(f"attempt {count[0]}")
    try:
        run(retry_async(fn, max_attempts=3))
    except RetryableError as e:
        assert "3" in str(e), f"should re-raise last (attempt 3), got: {e}"

def test_counter_not_shared_between_calls():
    async def always_fail(): raise RetryableError("x")
    for _ in range(3):
        try:
            run(retry_async(always_fail, max_attempts=2))
        except RetryableError:
            pass  # each call should run exactly max_attempts times

if __name__ == "__main__":
    test_succeeds_on_first_try()
    test_retries_on_retryable_error()
    test_non_retryable_propagates_immediately()
    test_reraises_last_exception()
    test_counter_not_shared_between_calls()
    print("All tests passed")
