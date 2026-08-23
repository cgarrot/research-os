#!/usr/bin/env python3
"""Exact-arithmetic claim checker (mathematics-lite).

Reads input.json: { expression, n, predicate }
Recomputes value = expression at n with exact integer arithmetic
(no trust in worker-supplied values), applies the predicate, prints a
JSON verdict, exits 0 if the predicate holds else 1.
"""
import json
import re
import sys


def is_prime(m: int) -> bool:
    if m < 2:
        return False
    if m % 2 == 0:
        return m == 2
    i = 3
    while i * i <= m:
        if m % i == 0:
            return False
        i += 2
    return True


def main() -> int:
    with open(sys.argv[1], "r", encoding="utf-8") as fh:
        data = json.load(fh)

    expr = str(data["expression"])
    n = int(data["n"])
    predicate = str(data["predicate"])

    if not re.fullmatch(r"[0-9n \t+\-*/()%]+", expr):
        print(json.dumps({"error": "expression must be integer arithmetic over n only", "expression": expr}))
        return 2

    try:
        value = eval(expr, {"__builtins__": {}}, {"n": n})  # noqa: S307 — sanitized above
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"error": f"evaluation failed: {exc}", "expression": expr, "n": n}))
        return 2

    if not isinstance(value, int):
        print(json.dumps({"error": "expression must evaluate to an integer", "expression": expr, "n": n, "value": str(value)}))
        return 2

    holds = False
    detail = predicate
    if predicate == "prime":
        holds = is_prime(value)
    elif predicate == "not_prime":
        holds = not is_prime(value)
        detail = f"not_prime(value) -> value factors check: is_prime({value}) = {is_prime(value)}"
    elif predicate == "even":
        holds = value % 2 == 0
    elif predicate == "odd":
        holds = value % 2 == 1
    elif predicate.startswith("equals:"):
        holds = value == int(predicate.split(":", 1)[1])
    elif predicate.startswith("divisible_by:"):
        d = int(predicate.split(":", 1)[1])
        holds = d != 0 and value % d == 0
    elif predicate.startswith("greater_than:"):
        holds = value > int(predicate.split(":", 1)[1])
    elif predicate.startswith("less_than:"):
        holds = value < int(predicate.split(":", 1)[1])
    else:
        print(json.dumps({"error": f"unknown predicate: {predicate}"}))
        return 2

    verdict = {
        "expression": expr,
        "n": n,
        "value": value,
        "predicate": predicate,
        "holds": holds,
        "detail": detail,
    }
    print(json.dumps(verdict))
    return 0 if holds else 1


if __name__ == "__main__":
    sys.exit(main())
