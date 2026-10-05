"""JSON CLI：从 stdin（或 argv[1] 指定的文件）读取一个 JSON 请求，
向 stdout 输出一个 JSON 响应。

命令：
  match               {command, alphabet, pattern, string}
  equivalent          {command, alphabet, left, right, budget?}
  included            {command, alphabet, left, right, budget?}
  shortest_difference {command, alphabet, left, right, budget?}
  resume              {command, state, budget?}
  automaton           {command, alphabet, pattern, budget?}
  verify_proof        {command, alphabet, left, right, proof}
"""
from __future__ import annotations

import json
import sys

from .ast import Context
from .parser import parse, ParseError
from . import engine
from .automaton import build_dfa, minimize


def _diff_json(res):
    if res.status == engine.EQUIVALENT:
        return {"status": "equivalent", "proof": res.proof,
                "explored": res.explored}
    if res.status == engine.DIFFERENT:
        return {"status": "different", "counterexample": res.counterexample,
                "side": res.side, "explored": res.explored}
    return {"status": "unknown", "state": res.state, "explored": res.explored}


def handle(req):
    cmd = req.get("command")
    if cmd == "resume":
        res = engine.resume_difference(req["state"], req.get("budget"))
        return _diff_json(res)
    if cmd == "verify_proof":
        ctx = Context(req["alphabet"])
        left, right = parse(ctx, req["left"]), parse(ctx, req["right"])
        return {"valid": engine.verify_proof(ctx, left, right, req["proof"])}
    ctx = Context(req["alphabet"])
    if cmd == "match":
        node = parse(ctx, req["pattern"])
        return {"match": ctx.match(node, req["string"])}
    if cmd == "automaton":
        node = parse(ctx, req["pattern"])
        dfa, frontier, truncated = build_dfa(ctx, node, req.get("budget"))
        out = {"truncated": truncated, "dfa": dfa.to_json()}
        if not truncated:
            out["minimized"] = minimize(dfa).to_json()
        else:
            out["frontier"] = [ctx.to_str(n) for n in frontier]
        return out
    if cmd in ("equivalent", "included", "shortest_difference"):
        left, right = parse(ctx, req["left"]), parse(ctx, req["right"])
        budget = req.get("budget")
        if cmd == "included":
            res = engine.included(ctx, left, right, budget)
            out = _diff_json(res)
            if res.status == engine.EQUIVALENT:
                out["status"] = "included"
                out.pop("proof", None)
            elif res.status == engine.DIFFERENT:
                out["status"] = "not_included"
            return out
        return _diff_json(engine.shortest_difference(ctx, left, right, budget))
    raise ValueError(f"unknown command: {cmd!r}")


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    try:
        if argv:
            with open(argv[0], "r", encoding="utf-8") as fh:
                req = json.load(fh)
        else:
            req = json.load(sys.stdin)
        out = handle(req)
    except (ParseError, ValueError, KeyError) as exc:
        out = {"error": f"{type(exc).__name__}: {exc}"}
    json.dump(out, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
