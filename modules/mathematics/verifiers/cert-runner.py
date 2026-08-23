#!/usr/bin/env python3
"""certificate-check runner (V0.5.3) — verifies a WITNESS with a worker-supplied
verify() function PLUS an optional exact expression check, all in this sandbox.

Input (input.json):
  {
    "script": "<python source defining verify(witness: dict) -> bool>",
    "witness": { ... arbitrary JSON witness ... },
    "expression": "n*n+n+41",          // optional exact cross-check (evaluated at the witness)
    "predicate": "prime",              // required iff expression is given
    "allDistinct": ["a","b","c","d"],  // optional: witness keys that must be pairwise distinct
    "tupleAllPrime": ["p","q"],        // optional: witness keys that must all be prime
  }

Exit codes: 0 = certificate VERIFIED (verify() true AND all exact checks pass),
            1 = witness rejected, 2 = input/structure error.
The runner decides the exit code — a worker script cannot force success without
passing verify() AND the exact checks.
"""
import importlib.util
import json
import re
import sys
import types

SCRIPT_ALLOWED = re.compile(r"^[A-Za-z0-9_+\-*/%()<>, .:\[\]{}=\"']*\n[A-Za-z0-9_+\-*/%()<>, .:\[\]{}=\"'\n]*$")


def main() -> int:
    try:
        with open(sys.argv[1], "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"error": f"bad input: {exc}"}))
        return 2

    script = str(data.get("script", ""))
    witness = data.get("witness", {})
    if not isinstance(witness, dict):
        print(json.dumps({"error": "witness must be a JSON object"}))
        return 2
    if not script.strip():
        print(json.dumps({"error": "script source is required (define verify(witness) -> bool)"}))
        return 2

    reasons = []

    # 1. optional structural checks on the witness
    all_distinct = [str(k) for k in data.get("allDistinct", [])]
    if all_distinct:
        vals = [witness[k] for k in all_distinct if k in witness]
        if len(vals) != len(all_distinct) or len(set(map(str, vals))) != len(vals):
            reasons.append(f"witness keys {all_distinct} not pairwise distinct/present")

    # import exact arithmetic for the optional cross-check and for prime tests
    spec = importlib.util.spec_from_file_location("checklib", __file__.replace("cert-runner.py", "check.py"))
    checklib = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(checklib)

    tuple_prime = [str(k) for k in data.get("tupleAllPrime", [])]
    if tuple_prime:
        for k in tuple_prime:
            if k not in witness or not isinstance(witness[k], int):
                reasons.append(f"witness[{k}] missing or not an integer")
            elif not checklib.is_prime(witness[k]):
                reasons.append(f"witness[{k}] = {witness[k]} is not prime")

    # 2. optional EXACT expression cross-check evaluated at the witness
    expression = data.get("expression")
    predicate = data.get("predicate")
    exact_detail = None
    if expression is not None:
        if not predicate:
            print(json.dumps({"error": "expression given without predicate"}))
            return 2
        try:
            env = {k: v for k, v in witness.items() if isinstance(v, int)}
            value = checklib.evaluate(str(expression), env)
            holds, exact_detail = checklib.check_predicate(value, str(predicate))
            if not holds:
                reasons.append(f"exact check failed: {exact_detail}")
        except Exception as exc:  # noqa: BLE001
            print(json.dumps({"error": f"exact check error: {exc}"}))
            return 2

    # 3. worker-supplied verify() — loaded as an isolated module
    try:
        mod = types.ModuleType("worker_cert")
        exec(compile(script, "<worker-certificate>", "exec"), mod.__dict__)  # noqa: S102 — sandboxed by design
        verify = getattr(mod, "verify", None)
        if not callable(verify):
            reasons.append("script does not define verify(witness) -> bool")
        else:
            verdict = verify(witness)
            if verdict is not True:
                reasons.append(f"verify(witness) returned {verdict!r} (must be exactly True)")
    except SystemExit:
        print(json.dumps({"error": "worker script attempted to control the runner exit — rejected"}))
        return 2
    except BaseException as exc:  # noqa: BLE001 — worker code must never crash the runner contract
        print(json.dumps({"error": f"worker script error: {exc}"}))
        return 2

    ok = len(reasons) == 0
    print(json.dumps({
        "mode": "witness",
        "verified": ok,
        "exactCheck": exact_detail,
        "reasons": reasons,
        "witnessKeys": sorted(witness.keys()),
    }))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
