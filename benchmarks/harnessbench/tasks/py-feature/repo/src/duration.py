def parse_duration(s):
    """ "1h30m" -> 5400. Units h/m/s, each once, h->m->s order.
    ValueError on empty/unknown/out-of-order/repeated/bare numbers."""
    raise NotImplementedError
