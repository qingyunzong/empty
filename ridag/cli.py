"""JSON command line interface.

Reads a spec from a file (or stdin) and writes results as JSON:

{
  "expression": {"op": "sub", "args": [{"op": "var", "name": "x"},
                                       {"op": "const", "value": "1"}]},
  "variables":  {"x": [["-2", "2", true, true]]},
  "evaluate":   true,
  "isolate":    {"var": "x", "budget": 1000},
  "verify":     true
}

Bounds are "p/q" strings, "inf" or "-inf"; each variable interval is
[lo, hi, lo_closed, hi_closed], and a variable maps to a list of such
intervals (a union).  Expression ops: const, var, add, sub, mul, div,
pow (integer "exp"), if ("cond"/"then"/"else").
"""

import argparse
import json
import sys

from .expr import Ctx, Env
from .isolate import isolate
from .jsonio import (expr_from_json, set_from_json, set_to_json,
                     output_to_json, cert_to_json)
from . import certcheck


def run_spec(spec, verify=False):
    ctx = Ctx()
    env = Env(ctx)
    f = expr_from_json(ctx, spec["expression"])
    for name, s in spec.get("variables", {}).items():
        env.set_var(name, set_from_json(s))
    result = {}
    if spec.get("evaluate"):
        v, h = env.eval(f)
        result["value"] = set_to_json(v)
        result["hole"] = h
    if "isolate" in spec:
        var = spec["isolate"]["var"]
        budget = int(spec["isolate"].get("budget", 1000))
        domain = env.get_var(var)
        outs = isolate(ctx, env, f, var, domain, budget=budget)
        result["outputs"] = [output_to_json(o) for o in outs]
        result["certificates"] = [cert_to_json(o) for o in outs]
        if verify:
            certcheck.verify(ctx, f, var, domain, outs)
            result["verification"] = "ok"
    return result


def main(argv=None):
    ap = argparse.ArgumentParser(prog="ridag")
    ap.add_argument("input", nargs="?", default="-",
                    help="JSON spec file (default: stdin)")
    ap.add_argument("--verify", action="store_true",
                    help="verify all certificates independently")
    args = ap.parse_args(argv)
    if args.input == "-":
        spec = json.load(sys.stdin)
    else:
        with open(args.input) as fh:
            spec = json.load(fh)
    result = run_spec(spec, verify=args.verify or spec.get("verify", False))
    json.dump(result, sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
