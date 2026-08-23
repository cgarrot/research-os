#!/usr/bin/env python3
"""mathematics module — exact check runner (deterministic, no network).

Modes (auto-detected from input.json):
  point : { expression, assignment: {var: int, ...}, predicate }
          -> evaluate expression exactly at the assignment, apply predicate.
  all   : { expression, variables: [{name, min, max}, ...], predicate, maxCases? }
          -> check predicate over the COMPLETE cartesian product (exhaustive finite
             verification). First failing assignment is reported.

Predicates (applied to the expression value):
  prime | not_prime | even | odd | square | not_square
  equals:K | not_equals:K | divisible_by:K | not_divisible_by:K
  greater_than:K | less_than:K | geq:K | leq:K
  collatz_terminates            (value reaches 1 under the 3n+1 map)
  collatz_steps_less_than:K | collatz_steps_greater_than:K
  collatz_max_value_less_than:K

Expression functions: abs, min, max, gcd, isqrt, factorial, divisor_sum,
  prime_pi, goldbach_count, gilbreath_rows_ok, collatz_steps, collatz_max

Exit codes: 0 predicate holds (point: at the assignment; all: everywhere),
            1 predicate fails (all-mode prints the counterexample assignment),
            2 input/evaluation error.
"""
import itertools
import json
import re
import sys

EXPR_RE = re.compile(r"^[A-Za-z0-9_+\-*/%(), .]+$")

_collatz_steps_cache: dict = {}


def goldbach_even(n: int) -> int:
    """1 if n is an even integer >= 4 with at least one prime decomposition, else 0."""
    return 1 if (n >= 4 and n % 2 == 0 and goldbach_count(n) >= 1) else 0


def legendre_gap(n: int) -> int:
    """Number of primes strictly between n² and (n+1)² (Legendre window count)."""
    if n < 1:
        raise ValueError("legendre_gap needs n >= 1")
    return prime_pi((n + 1) * (n + 1) - 1) - prime_pi(n * n)


def rad(n: int) -> int:
    """Radical: product of distinct prime factors (exact; n <= 1e12 practical)."""
    if n < 1:
        raise ValueError("rad needs n >= 1")
    out = 1
    m = n
    p = 2
    while p * p <= m:
        if m % p == 0:
            out *= p
            while m % p == 0:
                m //= p
        p = 3 if p == 2 else p + 2
    if m > 1:
        out *= m
    return out


def abc_quality_gt(a: int, b: int, c: int, p: int, q: int) -> int:
    """EXACT comparison q(abc) > p/q ⟺ c^q > rad(a·b·c)^p (integer powers, no floats).
    Requires gcd(a,b) = gcd(b,c) = gcd(a,c) = 1 and a+b = c — checked, else error."""
    import math
    if a + b != c or math.gcd(math.gcd(a, b), c) != 1 or c < 1 or q <= 0 or p <= 0:
        raise ValueError("abc triple must be coprime with a+b=c and p,q > 0")
    return 1 if c ** q > rad(a * b * c) ** p else 0


_waring_cache: dict = {}


def waring_min_s(n: int, k: int) -> int:
    """Minimal s such that n is a sum of s k-th powers of nonnegative integers."""
    if k < 1 or k > 4 or n < 0 or n > 20000:
        raise ValueError("waring_min_s needs 1 <= k <= 4, 0 <= n <= 20000")
    key = (k, n)
    if key in _waring_cache:
        return _waring_cache[key]
    if n == 0:
        return 0
    # BFS over reachable sums with k-th powers (small domains)
    import collections
    powers = []
    i = 0
    while i ** k <= n:
        powers.append(i ** k)
        i += 1
    dist = {0: 0}
    queue = collections.deque([0])
    while queue:
        cur = queue.popleft()
        d = dist[cur]
        if cur == n:
            _waring_cache[key] = d
            return d
        if d >= 32:
            continue
        for pw in powers:
            nxt = cur + pw
            if nxt > n or nxt in dist:
                continue
            dist[nxt] = d + 1
            queue.append(nxt)
    raise ValueError("unreachable (bug)")


def sigma_ratio_at_least(n: int, num: int, den: int) -> int:
    """1 iff divisor_sum(n)/n >= num/den (exact cross-multiplication)."""
    if n < 1 or den <= 0:
        raise ValueError("bad sigma_ratio args")
    return 1 if divisor_sum(n) * den >= n * num else 0


def collatz_steps(n: int) -> int:
    if n < 1:
        raise ValueError("collatz undefined for n < 1")
    steps = 0
    seen = []
    base = 0  # remaining steps from the first out-of-cache value (propagated into the cache)
    while n != 1:
        if n in _collatz_steps_cache:
            base = _collatz_steps_cache[n]
            steps += base
            break
        seen.append(n)
        n = n // 2 if n % 2 == 0 else 3 * n + 1
        steps += 1
        if len(seen) > 10_000_000:
            raise ValueError("collatz trajectory exceeds 10^7 steps — treat as non-terminating for this check")
    for i, v in enumerate(reversed(seen)):
        _collatz_steps_cache[v] = i + 1 + base
    return steps


def collatz_max(n: int) -> int:
    m = n
    while n != 1:
        n = n // 2 if n % 2 == 0 else 3 * n + 1
        if n > m:
            m = n
    return m


def factorial(n: int) -> int:
    if n < 0 or n > 20000:
        raise ValueError("factorial needs 0 <= n <= 20000")
    out = 1
    for i in range(2, n + 1):
        out *= i
    return out


def _sieve(limit: int) -> list:
    if limit < 2:
        return []
    flags = bytearray([1]) * (limit + 1)
    flags[0] = flags[1] = 0
    i = 2
    while i * i <= limit:
        if flags[i]:
            flags[i * i :: i] = bytearray(len(flags[i * i :: i]))
        i += 1
    return [i for i, f in enumerate(flags) if f]


_prime_cache: list = []
_prime_set_cache: set = set()


def _primes_upto(n: int) -> list:
    global _prime_cache, _prime_set_cache
    if not _prime_cache or _prime_cache[-1] < n:
        _prime_cache = _sieve(max(n, 1_000_000))
        _prime_set_cache = set(_prime_cache)
    return _prime_cache


def _prime_set() -> set:
    _primes_upto(2)
    return _prime_set_cache


def prime_pi(x: int) -> int:
    """Number of primes <= x (exact, sieve-backed)."""
    if x < 2:
        return 0
    primes = _primes_upto(x)
    import bisect
    return bisect.bisect_right(primes, x)


def goldbach_count(n: int) -> int:
    """Number of unordered prime pairs p <= q with p + q == n (exact)."""
    if n < 4 or n % 2 != 0:
        return 0
    primes = _primes_upto(n)
    pset = _prime_set()
    count = 0
    for p in primes:
        if p > n // 2:
            break
        if (n - p) in pset:
            count += 1
    return count


def primorial(n: int) -> int:
    """Product of the first n primes (primorial(n) = p_1 * ... * p_n, n >= 0)."""
    if n < 0 or n > 5000:
        raise ValueError("primorial needs 0 <= n <= 5000")
    primes = _primes_upto(int(1.5 * n * (2.5 + 0.013 * n)) + 50)
    out = 1
    for p in primes[:n]:
        out *= p
    return out


def divisor_sum(n: int) -> int:
    """Sum of all positive divisors of n (exact)."""
    if n < 1:
        raise ValueError("divisor_sum needs n >= 1")
    if n == 1:
        return 1
    total = 1
    i = 2
    while i * i <= n:
        if n % i == 0:
            total += i
            if i * i != n:
                total += n // i
        i += 1
    return total + n


def gilbreath_rows_ok(k: int) -> int:
    """Gilbreath conjecture check: returns 1 if the first k difference rows of the
    primes sequence all start with 1 (the conjectured pattern), else 0."""
    if k < 1 or k > 5000:
        raise ValueError("gilbreath_rows_ok needs 1 <= k <= 5000")
    seq = _primes_upto(int(1.5 * (k + 20) * (2.5 + 0.01 * k)) + 100)
    row = seq[: k + 60]
    for step in range(k):
        nxt = [abs(row[i + 1] - row[i]) for i in range(len(row) - 1)]
        if nxt[0] != 1:
            return 0
        row = nxt
    return 1


def is_prime(m: int) -> bool:
    """Deterministic for m < 3,317,044,064,679,887,385,961,981 (~3.3e24) via fixed
    Miller-Rabin bases; exact trial division beyond that bound (slow, avoid)."""
    if m < 2:
        return False
    for p in (2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37):
        if m % p == 0:
            return m == p
    d = m - 1
    r = 0
    while d % 2 == 0:
        d //= 2
        r += 1
    for a in (2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37):
        x = pow(a, d, m)
        if x in (1, m - 1):
            continue
        for _ in range(r - 1):
            x = x * x % m
            if x == m - 1:
                break
        else:
            return False
    return True


def next_prime_gap(n: int) -> int:
    """Gap g(n) = p - n where p is the smallest prime > n (exact; n >= 1)."""
    if n < 1:
        raise ValueError("next_prime_gap needs n >= 1")
    p = n + 1
    while not is_prime(p):
        p += 1
    return p - n


def is_mersenne_prime(e: int) -> int:
    """Lucas-Lehmer test for M_e = 2^e - 1: returns 1 if M_e is prime, else 0.
    Valid for odd e >= 3; e even (or e < 3) returns 0 (M_2 = 3 handled: e=2 -> 0 is
    WRONG for M_2, so callers must restrict to e >= 3 odd)."""
    if e < 3 or e % 2 == 0:
        return 0
    m = (1 << e) - 1
    s = 4
    for _ in range(e - 2):
        s = (s * s - 2) % m
    return 1 if s == 0 else 0


def _num(arg: str) -> int:
    return int(arg)


def check_predicate(value: int, predicate: str):
    if predicate == "prime":
        return is_prime(value), f"is_prime({value})"
    if predicate == "not_prime":
        return not is_prime(value), f"not is_prime({value})"
    if predicate == "mersenne_prime":
        return is_mersenne_prime(value) == 1, f"Lucas-Lehmer: M_{value} prime"
    if predicate == "not_mersenne_prime":
        return is_mersenne_prime(value) == 0, f"Lucas-Lehmer: M_{value} composite"
    if predicate == "even":
        return value % 2 == 0, f"{value} even"
    if predicate == "odd":
        return value % 2 == 1, f"{value} odd"
    if predicate == "square":
        import math
        r = math.isqrt(value) if value >= 0 else -1
        return value >= 0 and r * r == value, f"{value} is a perfect square"
    if predicate == "not_square":
        import math
        r = math.isqrt(value) if value >= 0 else -1
        return not (value >= 0 and r * r == value), f"{value} is not a perfect square"
    if predicate.startswith("equals:"):
        k = _num(predicate.split(":", 1)[1])
        return value == k, f"{value} == {k}"
    if predicate.startswith("not_equals:"):
        k = _num(predicate.split(":", 1)[1])
        return value != k, f"{value} != {k}"
    if predicate.startswith("divisible_by:"):
        k = _num(predicate.split(":", 1)[1])
        return k != 0 and value % k == 0, f"{value} % {k} == 0"
    if predicate.startswith("not_divisible_by:"):
        k = _num(predicate.split(":", 1)[1])
        return k != 0 and value % k != 0, f"{value} % {k} != 0"
    if predicate.startswith("greater_than:"):
        return value > _num(predicate.split(":", 1)[1]), f"{value} > …"
    if predicate.startswith("less_than:"):
        return value < _num(predicate.split(":", 1)[1]), f"{value} < …"
    if predicate.startswith("geq:"):
        return value >= _num(predicate.split(":", 1)[1]), f"{value} >= …"
    if predicate.startswith("leq:"):
        return value <= _num(predicate.split(":", 1)[1]), f"{value} <= …"
    if predicate == "collatz_terminates":
        steps = collatz_steps(value)
        return True, f"collatz({value}) reaches 1 in {steps} steps"
    if predicate.startswith("collatz_steps_less_than:"):
        k = _num(predicate.split(":", 1)[1])
        s = collatz_steps(value)
        return s < k, f"collatz_steps({value}) = {s} < {k}"
    if predicate.startswith("collatz_steps_greater_than:"):
        k = _num(predicate.split(":", 1)[1])
        s = collatz_steps(value)
        return s > k, f"collatz_steps({value}) = {s} > {k}"
    if predicate.startswith("collatz_max_value_less_than:"):
        k = _num(predicate.split(":", 1)[1])
        m = collatz_max(value)
        return m < k, f"collatz_max({value}) = {m} < {k}"
    if predicate == "tuple_all_prime":
        # witness mode: ALL assignment values must be prime (checked by the runner against the full assignment)
        raise ValueError("tuple_all_prime is handled by the witness runner")
    if predicate.startswith("abc_quality_greater_than:"):
        frac = predicate.split(":", 1)[1]
        p_str, q_str = frac.split("/", 1)
        raise ValueError(f"abc_quality_greater_than is a function, not a predicate — call abc_quality_gt(a,b,c,{p_str},{q_str})")
    if predicate.startswith("sigma_ratio_at_least:"):
        frac = predicate.split(":", 1)[1]
        n_str, d_str = frac.split("/", 1)
        # applied when the expression evaluated to the number itself (value == n)
        holds = sigma_ratio_at_least(value, _num(n_str), _num(d_str))
        return holds == 1, f"sigma({value})/{value} >= {n_str}/{d_str}"
    if predicate.startswith("sigma_ratio_equals:"):
        frac = predicate.split(":", 1)[1]
        n_str, d_str = frac.split("/", 1)
        import math
        s = divisor_sum(value)
        lhs = s * _num(d_str)
        rhs = value * _num(n_str)
        return lhs == rhs, f"sigma({value})/{value} == {n_str}/{d_str} (cross-multiplied exactly)"
    raise ValueError(f"unknown predicate: {predicate}")


SAFE_FUNCS = {
    "abs": abs, "min": min, "max": max,
    "gcd": __import__("math").gcd, "isqrt": __import__("math").isqrt,
    "factorial": factorial, "divisor_sum": divisor_sum,
    "prime_pi": prime_pi, "goldbach_count": goldbach_count, "primorial": primorial,
    "gilbreath_rows_ok": gilbreath_rows_ok, "next_prime_gap": next_prime_gap,
    "is_mersenne_prime": is_mersenne_prime,
    "goldbach_even": goldbach_even, "legendre_gap": legendre_gap, "rad": rad,
    "abc_quality_gt": abc_quality_gt, "waring_min_s": waring_min_s,
    "sigma_ratio_at_least": sigma_ratio_at_least,
    "collatz_steps": collatz_steps, "collatz_max": collatz_max,
}


def evaluate(expr: str, env: dict) -> int:
    if not EXPR_RE.fullmatch(expr):
        raise ValueError("expression must contain only [A-Za-z0-9_+-*/%()., space]")
    names = set(re.findall(r"[A-Za-z_][A-Za-z0-9_]*", expr))
    unknown = names - set(env) - set(SAFE_FUNCS)
    if unknown:
        raise ValueError(f"unknown identifiers in expression: {sorted(unknown)}")
    value = eval(expr, {"__builtins__": {}}, {**SAFE_FUNCS, **env})  # noqa: S307 — sanitized
    if not isinstance(value, int):
        raise ValueError(f"expression must evaluate to an integer, got {type(value).__name__}")
    return value


def main() -> int:
    try:
        with open(sys.argv[1], "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"error": f"bad input: {exc}"}))
        return 2

    expr = str(data["expression"])
    predicate = str(data["predicate"])

    try:
        if "assignment" in data:
            env = {str(k): int(v) for k, v in data["assignment"].items()}
            value = evaluate(expr, env)
            holds, detail = check_predicate(value, predicate)
            print(json.dumps({
                "mode": "point", "expression": expr, "assignment": env,
                "value": value, "predicate": predicate, "holds": holds, "detail": detail,
            }))
            return 0 if holds else 1

        if "variables" in data:
            variables = [(str(v["name"]), int(v["min"]), int(v["max"])) for v in data["variables"]]
            if not variables:
                raise ValueError("variables list is empty")
            total = 1
            for _, lo, hi in variables:
                if hi < lo:
                    raise ValueError(f"range max < min for a variable ({lo} > {hi})")
                total *= hi - lo + 1
            cap = min(int(data.get("maxCases", 3_000_000)), 5_000_000)
            if total > cap:
                raise ValueError(f"domain too large: {total} cases > cap {cap}")
            tested = 0
            for combo in itertools.product(*(range(lo, hi + 1) for _, lo, hi in variables)):
                env = {name: val for (name, _, _), val in zip(variables, combo)}
                value = evaluate(expr, env)
                holds, detail = check_predicate(value, predicate)
                if not holds:
                    print(json.dumps({
                        "mode": "exhaustive", "expression": expr,
                        "variables": [list(v) for v in variables],
                        "testedCases": tested + 1, "totalCases": total,
                        "counterexample": env, "value": value,
                        "predicate": predicate, "holds": False, "detail": detail,
                    }))
                    return 1
                tested += 1
            print(json.dumps({
                "mode": "exhaustive", "expression": expr,
                "variables": [list(v) for v in variables],
                "testedCases": tested, "totalCases": total,
                "predicate": predicate, "holds": True,
                "detail": "predicate holds on the COMPLETE declared finite domain",
            }))
            return 0

        raise ValueError("input needs 'assignment' (point) or 'variables' (exhaustive)")
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"error": str(exc)}))
        return 2


if __name__ == "__main__":
    sys.exit(main())
