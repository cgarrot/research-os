#!/usr/bin/env python3
"""hunt.py — certificate hunting workbench (Mathematics module v0.2, spec §8).

A durable search engine for checkable combinatorial certificates. Runs as a
ResearchOS JOB (detached from Pi agents), prints NDJSON telemetry, checkpoints
to disk, resumes from checkpoints, and ends with a final INDEPENDENT validation
of the best candidate (search ≠ verification).

Built-in problems:
  vdw      --problem vdw --n 3704 --k 7
            binary coloring of [1,n] with no monochromatic k-term AP.
            metric: "n=3704, violations=0" when valid.
  ramsey   --problem ramsey --v 36 --a 4 --b 6
            simple graph on v vertices with no K_a and no independent set of b.
            (v=36,a=4,b=6 -> would prove R(4,6) >= 37.)

Strategies: random-restart, hill, sa (simulated annealing), tabu, evo.
Usage:
  python3 hunt.py --problem vdw --n 3704 --k 7 --strategy sa --seconds 3600 \
      --checkpoint ckpt.json --seed 1
Output lines:
  {"PROGRESS": {...}}   telemetry (captured as job metric)
  {"RESULT": {...}}     final: valid?, certificate, score, steps, wall time
Exit code 0 iff a valid certificate was found AND independently revalidated.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import random
import sys
import time

# ---------------------------------------------------------------- problems


class Problem:
    """A certificate search problem. The final validate() is INDEPENDENT of the
    search score path (recount from scratch)."""

    name = "?"

    def size(self) -> int:  # candidate size (bits/vars)
        raise NotImplementedError

    def initial(self, rng: random.Random) -> list[int]:
        raise NotImplementedError

    def score(self, x: list[int]) -> float:  # higher = better, 0 = valid target
        raise NotImplementedError

    def neighbors(self, x: list[int], rng: random.Random) -> list[int]:
        raise NotImplementedError

    def serialize(self, x: list[int]) -> str:
        return "".join(str(b) for b in x)

    def validate(self, x: list[int]) -> bool:  # independent final check
        raise NotImplementedError

    def describe(self, x: list[int]) -> str:
        return ""


class VdW(Problem):
    """Binary coloring of [1,n] avoiding monochromatic k-term arithmetic progressions."""

    name = "vdw"

    def __init__(self, n: int, k: int):
        self.n = n
        self.k = k
        # precompute AP index tuples
        aps = []
        for d in range(1, n // (k - 1) + 1):
            for a in range(1, n - (k - 1) * d + 1):
                aps.append(tuple(a + i * d - 1 for i in range(k)))
        self.aps = aps
        self._score_cache: dict[int, int] = {}

    def size(self) -> int:
        return self.n

    def initial(self, rng: random.Random) -> list[int]:
        return [rng.randint(0, 1) for _ in range(self.n)]

    def _violations(self, x: list[int], limit: int | None = None) -> int:
        v = 0
        for ap in self.aps:
            c = x[ap[0]]
            if all(x[i] == c for i in ap):
                v += 1
                if limit is not None and v > limit:
                    return v
        return v

    def score(self, x: list[int]) -> float:
        return -float(self._violations(x))

    def neighbors(self, x: list[int], rng: random.Random) -> list[int]:
        # repair-biased: flip a member of a violated AP (found by sampling), else random bit
        out = list(x)
        for _ in range(200):
            ap = rng.choice(self.aps)
            c = out[ap[0]]
            if all(out[i] == c for i in ap):
                i = ap[rng.randrange(self.k)]
                out[i] ^= 1
                return out
        # fallback: 2-bit perturbation
        out[rng.randrange(self.n)] ^= 1
        if rng.random() < 0.3:
            out[rng.randrange(self.n)] ^= 1
        return out

    def serialize(self, x: list[int]) -> str:
        return "".join(str(b) for b in x)

    def validate(self, x: list[int]) -> bool:
        return len(x) == self.n and self._violations(x, limit=0) == 0

    def describe(self, x: list[int]) -> str:
        return f"vdw n={self.n} k={self.k} violations={self._violations(x)}"


class RamseyCirculant(Problem):
    """Circulant Ramsey graphs (symmetry-reduced search space): variables are the
    connection set S subset of {1..v//2}; edge (i,j) iff (i-j) mod v in S + (-S).
    Known critical graphs (e.g. Paley P(17) for R(4,4)=18) live here."""

    name = "ramsey-circulant"

    def __init__(self, v: int, a: int, b: int):
        self.v, self.a, self.b = v, a, b
        self.half = v // 2
        # full Ramsey machinery for validation
        self._full = Ramsey(v, a, b)

    def size(self) -> int:
        return self.half

    def initial(self, rng: random.Random) -> list[int]:
        return [rng.randint(0, 1) for _ in range(self.half)]

    def expand(self, x: list[int]) -> list[int]:
        edges = []
        for i in range(self.v):
            for j in range(i):
                d = min((i - j) % self.v, (j - i) % self.v)
                edges.append(1 if (1 <= d <= self.half and x[d - 1]) else 0)
        return edges

    def score(self, x: list[int]) -> float:
        return self._full.score(self.expand(x))

    def neighbors(self, x: list[int], rng: random.Random) -> list[int]:
        out = list(x)
        out[rng.randrange(self.half)] ^= 1
        return out

    def serialize(self, x: list[int]) -> str:
        return "".join(str(b) for b in x)

    def validate(self, x: list[int]) -> bool:
        return len(x) == self.half and self._full.validate(self.expand(x))

    def describe(self, x: list[int]) -> str:
        S = [i + 1 for i, b in enumerate(x) if b]
        return f"ramsey-circulant v={self.v} K{self.a}/I{self.b} S={S} violations={self.score(x)}"


class Ramsey(Problem):
    """Simple graph on v vertices avoiding K_a and independent b-sets (bit-per-edge, lower triangle)."""

    name = "ramsey"

    def __init__(self, v: int, a: int, b: int):
        self.v, self.a, self.b = v, a, b
        self.edges = [(i, j) for i in range(v) for j in range(i)]
        self.eidx = {e: t for t, e in enumerate(self.edges)}
        self.masks = [0] * v  # masks[i] = adjacency bitmask over indices < v
        # precompute neighbor-index lists as bitmasks for clique checks
        self._all = (1 << v) - 1

    def size(self) -> int:
        return len(self.edges)

    def initial(self, rng: random.Random) -> list[int]:
        # dense-ish random start (records are usually near-regular with density ~1/2)
        return [1 if rng.random() < 0.5 else 0 for _ in self.edges]

    def _adj(self, x: list[int]) -> list[int]:
        m = [0] * self.v
        for t, (i, j) in enumerate(self.edges):
            if x[t]:
                m[i] |= 1 << j
                m[j] |= 1 << i
        return m

    def _count_cliques(self, adj: list[int], size: int) -> int:
        """Count K_size in the graph given by adj (used for K_a, and for independent
        b-sets by passing the complement)."""
        v = self.v
        count = 0
        # iterate cliques with standard recursive expansion + bitmask intersection
        def extend(verts: tuple[int, ...], cand_mask: int) -> None:
            nonlocal count
            if len(verts) == size:
                count += 1
                return
            if cand_mask == 0:
                return
            # prune: not enough candidates left
            if bin(cand_mask).count("1") < size - len(verts):
                return
            m = cand_mask
            while m:
                i = (m & -m).bit_length() - 1
                m &= m - 1
                if i <= (verts[-1] if verts else -1):
                    continue
                extend(verts + (i,), cand_mask & adj[i] & ~((1 << (i + 1)) - 1) if False else cand_mask & adj[i])
                # bound blow-up: stop after a heap of cliques for scoring purposes
                if count > 4096:
                    return
        extend((), self._all)
        return count

    def _violations(self, x: list[int]) -> int:
        adj = self._adj(x)
        comp = [(~adj[i]) & self._all & ~(1 << i) for i in range(self.v)]
        c1 = self._count_cliques(adj, self.a)
        c2 = self._count_cliques(comp, self.b)
        return c1 + c2

    def score(self, x: list[int]) -> float:
        return -float(self._violations(x))

    def neighbors(self, x: list[int], rng: random.Random) -> list[int]:
        out = list(x)
        # repair-biased: find one violation and flip one of its edges
        adj = self._adj(x)
        comp = [(~adj[i]) & self._all & ~(1 << i) for i in range(self.v)]
        viol_edges: set[int] = set()
        found = self._find_clique(adj, self.a)
        if found:
            i, j = self._pair_in(found)
            viol_edges.add(self.eidx[(max(i, j), min(i, j))])
        found = self._find_clique(comp, self.b)
        if found:
            i, j = self._pair_in(found)
            viol_edges.add(self.eidx[(max(i, j), min(i, j))])
        if viol_edges and rng.random() < 0.9:
            t = rng.choice(sorted(viol_edges))
            out[t] ^= 1
            return out
        out[rng.randrange(len(out))] ^= 1
        if rng.random() < 0.3:
            out[rng.randrange(len(out))] ^= 1
        return out

    def _pair_in(self, verts: tuple[int, ...]) -> tuple[int, int]:
        a, b = verts[0], verts[1]
        return a, b

    def _find_clique(self, adj: list[int], size: int) -> tuple[int, ...] | None:
        def extend(verts: tuple[int, ...], cand_mask: int):
            if len(verts) == size:
                return verts
            if cand_mask == 0 or bin(cand_mask).count("1") < size - len(verts):
                return None
            m = cand_mask
            while m:
                i = (m & -m).bit_length() - 1
                m &= m - 1
                r = extend(verts + (i,), cand_mask & adj[i])
                if r:
                    return r
            return None
        return extend((), self._all)

    def serialize(self, x: list[int]) -> str:
        return "".join(str(b) for b in x)

    def validate(self, x: list[int]) -> bool:
        # independent recount WITHOUT the 4096 blow-up cap (full enumeration)
        adj = self._adj(x)
        comp = [(~adj[i]) & self._all & ~(1 << i) for i in range(self.v)]
        saved = self._count_cliques.__code__  # noqa: F841
        full = self._full_count(adj, self.a) + self._full_count(comp, self.b)
        return full == 0

    def _full_count(self, adj: list[int], size: int) -> int:
        count = 0

        def extend(verts: tuple[int, ...], cand_mask: int) -> None:
            nonlocal count
            if len(verts) == size:
                count += 1
                return
            if cand_mask == 0 or bin(cand_mask).count("1") < size - len(verts):
                return
            m = cand_mask
            while m:
                i = (m & -m).bit_length() - 1
                m &= m - 1
                extend(verts + (i,), cand_mask & adj[i])
        extend((), self._all)
        return count

    def describe(self, x: list[int]) -> str:
        e = sum(x)
        return f"ramsey v={self.v} K{self.a}/I{self.b} edges={e} violations={self._violations(x)}"


# ---------------------------------------------------------------- strategies


def run_search(prob: Problem, strategy: str, seconds: float, rng: random.Random, emit, ckpt: dict | None):
    deadline = time.time() + seconds
    best = None
    best_s = -math.inf
    cur = None
    cur_s = -math.inf
    steps = 0
    restarts = 0
    tabu: dict[int, float] = {}
    population: list[tuple[float, list[int]]] = []
    t0 = time.time()
    last_emit = t0

    def checkpoint(obj: dict):
        return obj  # caller handles persistence

    if ckpt and "state" in ckpt:
        cur = [int(c) for c in ckpt["state"]]
        best = [int(c) for c in ckpt.get("best", cur)]
        best_s = prob.score(best)
        cur_s = prob.score(cur)

    if cur is None:
        cur = prob.initial(rng)
        cur_s = prob.score(cur)
        best, best_s = list(cur), cur_s

    while time.time() < deadline:
        steps += 1
        if strategy == "random-restart":
            cand = prob.initial(rng)
        else:
            cand = prob.neighbors(cur, rng)
        s = prob.score(cand)

        accept = False
        if strategy in ("hill", "random-restart"):
            accept = s >= cur_s
        elif strategy == "sa":
            frac = (deadline - time.time()) / max(seconds, 1e-9)  # 1 -> 0
            # adaptive: scale T by a running estimate of typical |delta|
            scale = max(1.0, abs(s - cur_s), abs(cur_s) * 0.15)
            T = (0.01 + 0.8 * frac) * scale
            accept = s >= cur_s or rng.random() < math.exp(min(0.0, (s - cur_s) / T))
        elif strategy == "tabu":
            h = hash(prob.serialize(cand)) & 0xFFFFFFFF
            accept = s >= cur_s or tabu.get(h, 0) < time.time()
            tabu[h] = time.time() + 5.0
        elif strategy == "evo":
            if len(population) < 20:
                population.append((s, cand))
                accept = False
            else:
                population.sort(key=lambda p: -p[0])
                p1, p2 = population[0][1], population[1][1]
                cut = rng.randrange(len(cand))
                child = p1[:cut] + p2[cut:]
                for _ in range(rng.randrange(1, 4)):
                    child[rng.randrange(len(child))] ^= 1
                cand = child
                s = prob.score(cand)
                accept = s >= population[-1][0]
                if accept:
                    population[-1] = (s, cand)
        if accept:
            cur, cur_s = cand, s
        if s > best_s:
            best, best_s = list(cand), s
            emit("PROGRESS", {"best": best_s, "step": steps, "t": round(time.time() - t0, 1), "event": "new-best"})
        if strategy not in ("random-restart",) and best_s >= 0 and cur_s < best_s - 50 and rng.random() < 0.01:
            cur, cur_s = list(best), best_s  # soft restart to best
        if strategy == "random-restart" and steps % 500 == 0:
            restarts += 1
        if time.time() - last_emit > 30:
            last_emit = time.time()
            emit("PROGRESS", {"best": best_s, "cur": cur_s, "step": steps, "t": round(time.time() - t0, 1)})
    return best, best_s, steps, restarts


# ---------------------------------------------------------------- main


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--problem", required=True, choices=["vdw", "ramsey", "ramsey-circulant"])
    ap.add_argument("--n", type=int)
    ap.add_argument("--k", type=int, default=7)
    ap.add_argument("--v", type=int)
    ap.add_argument("--a", type=int, default=4)
    ap.add_argument("--b", type=int, default=6)
    ap.add_argument("--strategy", default="sa", choices=["random-restart", "hill", "sa", "tabu", "evo"])
    ap.add_argument("--seconds", type=float, default=3600)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--checkpoint", default="")
    args = ap.parse_args()

    rng = random.Random(args.seed)
    if args.problem == "vdw":
        if not args.n:
            print(json.dumps({"error": "--n required"}))
            return 2
        prob = VdW(args.n, args.k)
    else:
        if not args.v:
            print(json.dumps({"error": "--v required"}))
            return 2
        prob = RamseyCirculant(args.v, args.a, args.b) if args.problem == "ramsey-circulant" else Ramsey(args.v, args.a, args.b)

    def emit(kind: str, obj: dict) -> None:
        print(json.dumps({kind: obj}), flush=True)

    ckpt = None
    if args.checkpoint and os.path.exists(args.checkpoint):
        try:
            with open(args.checkpoint) as fh:
                ckpt = json.load(fh)
            emit("PROGRESS", {"event": "resumed", "from": args.checkpoint})
        except Exception:
            ckpt = None

    emit("PROGRESS", {"event": "start", "problem": prob.name, "strategy": args.strategy, "seconds": args.seconds, "seed": args.seed})

    best, best_s, steps, restarts = run_search(prob, args.strategy, args.seconds, rng, emit, ckpt)

    valid = prob.validate(best) if best_s >= 0 else False
    result = {
        "valid": valid,
        "problem": prob.name,
        "strategy": args.strategy,
        "seed": args.seed,
        "steps": steps,
        "restarts": restarts,
        "wall": round(time.time(), 1),
        "describe": prob.describe(best) if best else "",
        "certificate": prob.serialize(best) if best else "",
    }
    if args.checkpoint:
        with open(args.checkpoint + ".final", "w") as fh:
            json.dump(result, fh)
        if not valid and best:
            with open(args.checkpoint, "w") as fh:
                json.dump({"state": best, "best": best, "seed": args.seed}, fh)
    print(json.dumps({"RESULT": result}), flush=True)
    return 0 if valid else 1


if __name__ == "__main__":
    sys.exit(main())
