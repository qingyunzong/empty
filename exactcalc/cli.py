"""JSON command-line interface for the exactcalc library.

Reads one JSON request from a file (argv[1]) or stdin and writes one JSON
response to stdout.  Big integers may be passed as JSON numbers or decimal
strings; rationals as "num/den" strings.

Commands:
  int_root      {"cmd":"int_root","n":N,"k":K}
  verify_root   {"cmd":"verify_root","n":N,"k":K,"r":R}
  isolate       {"cmd":"isolate","poly":[c0,c1,...]}
  floor|ceil    {"cmd":"floor","poly":[...],"lo":"a/b","hi":"c/d","budget":0}
  round         same, plus optional "scale":["p","q"] and "mode"
  compare       {"cmd":"compare","a":{...},"b":{...}}

Any request may carry "cache_file": path; the evidence cache is loaded
(and verified) before the command runs and saved back afterwards.
"""
import json
import os
import sys
from fractions import Fraction

from . import introot
from .algebraic import AlgebraicNumber
from .cache import EvidenceCache


def _int(v):
    if isinstance(v, bool):
        raise ValueError("boolean is not an integer")
    return int(v)


def _frac(v):
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return Fraction(v)
    return Fraction(str(v))


def _alg(spec, cache):
    if "exact" in spec:
        return AlgebraicNumber.from_rational(_frac(spec["exact"]), cache=cache)
    return AlgebraicNumber(
        [_int(c) for c in spec["poly"]],
        _frac(spec["lo"]),
        _frac(spec["hi"]),
        cache=cache,
    )


def _rounding(req, cache, mode):
    budget = req.get("budget")
    if budget is not None:
        budget = _int(budget)
    if "scale" in req:
        p, q = req["scale"]
        value = _alg(req, cache).scaled_round(_int(p), _int(q), mode=mode,
                                              budget=budget)
    else:
        alg = _alg(req, cache)
        if mode == "floor":
            value = alg.floor(budget)
        elif mode == "ceil":
            value = alg.ceil(budget)
        else:
            value = alg.round_half_even(budget)
    return {"ok": True, "result": value}


def handle(req, cache=None):
    cmd = req.get("cmd")
    if cmd == "int_root":
        ev = introot.root_evidence(_int(req["n"]), _int(req["k"]))
        return {"ok": True, "r": ev["r"], "evidence": ev}
    if cmd == "verify_root":
        evidence = req.get("evidence", req)
        return {"ok": True, "valid": introot.verify_root_evidence(evidence)}
    if cmd == "isolate":
        roots = AlgebraicNumber.all_real_roots([_int(c) for c in req["poly"]],
                                               cache=cache)
        return {"ok": True, "roots": [r.state_json() for r in roots]}
    if cmd in ("floor", "ceil"):
        return _rounding(req, cache, cmd)
    if cmd == "round":
        return _rounding(req, cache, req.get("mode", "half_even"))
    if cmd == "compare":
        a = _alg(req["a"], cache)
        b = _alg(req["b"], cache)
        budget = req.get("budget")
        return {"ok": True,
                "result": a.compare(b, _int(budget) if budget is not None else None)}
    raise ValueError(f"unknown command: {cmd!r}")


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    raw = open(argv[0]).read() if argv else sys.stdin.read()
    try:
        req = json.loads(raw)
    except json.JSONDecodeError as e:
        print(json.dumps({"ok": False, "error": f"invalid JSON: {e}"}))
        return 2
    cache = None
    cache_file = req.get("cache_file") if isinstance(req, dict) else None
    try:
        if cache_file:
            cache = (EvidenceCache.load(cache_file)
                     if os.path.exists(cache_file) else EvidenceCache())
        resp = handle(req, cache)
    except Exception as e:  # noqa: BLE001 - report any failure as JSON
        resp = {"ok": False, "error": f"{type(e).__name__}: {e}"}
    if cache_file and cache is not None and resp.get("ok"):
        cache.save(cache_file)
    print(json.dumps(resp, indent=2))
    return 0 if resp.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
