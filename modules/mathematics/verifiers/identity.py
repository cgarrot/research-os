#!/usr/bin/env python3
"""mathematics module — symbolic identity verifier (sympy, deterministic).

Input: { left, right, variables: ["x", "y"]? }
Verifies simplify(left) - simplify(right) == 0 symbolically over the default
sympy simplification (an exact proof for polynomial/rational identities; the
output records the assumption domain).

Exit codes: 0 identity holds, 1 not proven an identity (NOT a disproof), 2 error.
"""
import json
import re
import sys

import sympy

EXPR_RE = re.compile(r"^[A-Za-z0-9_+\-*/%^(), .]+$")


def main() -> int:
    try:
        with open(sys.argv[1], "r", encoding="utf-8") as fh:
            data = json.load(fh)
        left_s, right_s = str(data["left"]), str(data["right"])
        var_names = [str(v) for v in data.get("variables", [])]
        for s in (left_s, right_s):
            if not EXPR_RE.fullmatch(s):
                raise ValueError("expressions must contain only [A-Za-z0-9_+-*/%()., space]")
        symbols = {name: sympy.Symbol(name) for name in var_names}
        known = {"pi": sympy.pi, "E": sympy.E}
        env = {**symbols, **known}
        unknown = set(re.findall(r"[A-Za-z_][A-Za-z0-9_]*", left_s + right_s)) - set(env)
        if unknown:
            raise ValueError(f"undeclared symbols (pass them in variables): {sorted(unknown)}")
        left = sympy.sympify(left_s, locals=env)
        right = sympy.sympify(right_s, locals=env)
        diff = sympy.simplify(left - right)
        holds = diff == 0
        print(json.dumps({
            "left": left_s, "right": right_s, "variables": var_names,
            "simplifiedDifference": str(diff),
            "holds": holds,
            "assumptionDomain": "sympy default (exact symbolic simplification; proof-grade for polynomial/rational identities)",
        }))
        return 0 if holds else 1
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"error": str(exc)}))
        return 2


if __name__ == "__main__":
    sys.exit(main())
