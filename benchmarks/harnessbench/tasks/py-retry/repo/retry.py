import asyncio

class RetryableError(Exception): pass

async def retry_async(fn, max_attempts=3, delay=0.0, _attempts=[0]):
    """Call fn(), retrying up to max_attempts times on RetryableError."""
    _attempts[0] = 0
    first_exc = None
    while _attempts[0] < max_attempts:
        try:
            return await fn()
        except Exception as e:
            if first_exc is None:
                first_exc = e
            _attempts[0] += 1
            if delay > 0:
                await asyncio.sleep(delay)
    raise first_exc
