#!/usr/bin/env python3
"""lean-kernel verifier runner (V0.8) — compiles a Lean 4 proof artifact and
accepts ONLY on clean compilation with no escape hatches.

Input (input.json):
  { "source": "<lean source of the theorem + proof>" }

Exit codes: 0 = accepted (compiles clean, no sorry/admit/native_decide),
            1 = rejected (compile error, or escape hatch detected),
            2 = environment error (lean not installed / wrong toolchain).

Without a Lean toolchain this verifier ERRORS (exit 2) — it never passes.
Install elan + a pinned toolchain to enable formal verification.
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

FORBIDDEN = re.compile(r"\b(sorry|admit|native_decide|axiom)\b")


def main() -> int:
    try:
        with open(sys.argv[1], "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"error": f"bad input: {exc}"}))
        return 2

    source = str(data.get("source", "")).strip()
    if not source:
        print(json.dumps({"error": "source is required (Lean 4 theorem + proof)"}))
        return 2

    lake = shutil.which("lake")
    lean = shutil.which("lean")
    elan = shutil.which("elan")
    if not (lake and lean):
        print(json.dumps({
            "error": "Lean toolchain not installed",
            "detail": f"lake={bool(lake)} lean={bool(lean)} elan={bool(elan)}",
            "how": "install elan (https://github.com/leanprover/elan) and pin a toolchain",
        }))
        return 2

    if FORBIDDEN.search(source):
        found = sorted(set(FORBIDDEN.findall(source)))
        print(json.dumps({"accepted": False, "reason": f"forbidden escape hatches present: {found}"}))
        return 1

    with tempfile.TemporaryDirectory(prefix="lean-verify-") as td:
        file = os.path.join(td, "Theorem.lean")
        with open(file, "w", encoding="utf-8") as fh:
            fh.write(source + "\n")
        try:
            proc = subprocess.run(
                [lean, file],
                capture_output=True, text=True, timeout=300,
                cwd=td,
            )
        except subprocess.TimeoutExpired:
            print(json.dumps({"accepted": False, "reason": "compilation timed out (300s)"}))
            return 1
        accepted = proc.returncode == 0 and not proc.stderr.strip()
        print(json.dumps({
            "accepted": accepted,
            "exitCode": proc.returncode,
            "stdout": proc.stdout[-2000:],
            "stderr": proc.stderr[-2000:],
        }))
        return 0 if accepted else 1


if __name__ == "__main__":
    sys.exit(main())
