"""JSON serialization for endpoints, intervals, DAGs and certificates."""

from __future__ import annotations

from fractions import Fraction

from .dag import DAG
from .interval import End, Interval, IntervalUnion


# -- endpoints / intervals -------------------------------------------------

def end_to_json(e):
    if e.is_inf:
        return "inf" if e.inf_sign > 0 else "-inf"
    v = e.val
    return str(v.numerator) if v.denominator == 1 else "%d/%d" % (
        v.numerator, v.denominator)


def end_from_json(j):
    if j in ("inf", "+inf"):
        return End.inf(1)
    if j == "-inf":
        return End.inf(-1)
    return End(Fraction(j))


def interval_to_json(iv):
    return {
        "lo": end_to_json(iv.lo),
        "lo_open": iv.lo_open,
        "hi": end_to_json(iv.hi),
        "hi_open": iv.hi_open,
    }


def interval_from_json(j):
    return Interval(end_from_json(j["lo"]), bool(j.get("lo_open", False)),
                    end_from_json(j["hi"]), bool(j.get("hi_open", False)))


def union_to_json(u):
    return [interval_to_json(i) for i in u.intervals]


def union_from_json(j):
    return IntervalUnion([interval_from_json(x) for x in j])


# -- DAG -------------------------------------------------------------------

def dag_to_json(dag, root):
    nodes = []
    for n in dag.nodes:
        rec = {"id": n.uid, "op": n.op}
        if n.op == "const":
            rec["value"] = end_to_json(End(n.args[0]))
        elif n.op == "var":
            rec["name"] = n.args[0]
        elif n.op == "pow":
            rec["args"] = [n.args[0].uid]
            rec["exp"] = n.args[1]
        else:
            rec["args"] = [a.uid for a in n.args]
        nodes.append(rec)
    return {"nodes": nodes, "root": root.uid}


def dag_from_json(j):
    dag = DAG()
    built = {}
    for rec in j["nodes"]:
        op = rec["op"]
        if op == "const":
            node = dag.const(Fraction(rec["value"]))
        elif op == "var":
            node = dag.var(rec["name"])
        elif op == "add":
            node = dag.add(built[rec["args"][0]], built[rec["args"][1]])
        elif op == "sub":
            node = dag.sub(built[rec["args"][0]], built[rec["args"][1]])
        elif op == "mul":
            node = dag.mul(built[rec["args"][0]], built[rec["args"][1]])
        elif op == "div":
            node = dag.div(built[rec["args"][0]], built[rec["args"][1]])
        elif op == "neg":
            node = dag.neg(built[rec["args"][0]])
        elif op == "pow":
            node = dag.pow(built[rec["args"][0]], int(rec["exp"]))
        elif op == "cond":
            node = dag.cond(built[rec["args"][0]], built[rec["args"][1]],
                            built[rec["args"][2]])
        else:
            raise ValueError("unknown op %r" % op)
        built[rec["id"]] = node
    return dag, built[j["root"]]


def expr_from_json(dag, j):
    """Build an expression node from a compact JSON tree."""
    if isinstance(j, (int, str)):
        return dag.const(Fraction(j))
    if "const" in j:
        return dag.const(Fraction(j["const"]))
    if "var" in j:
        return dag.var(j["var"])
    if "add" in j:
        a, b = j["add"]
        return dag.add(expr_from_json(dag, a), expr_from_json(dag, b))
    if "sub" in j:
        a, b = j["sub"]
        return dag.sub(expr_from_json(dag, a), expr_from_json(dag, b))
    if "mul" in j:
        a, b = j["mul"]
        return dag.mul(expr_from_json(dag, a), expr_from_json(dag, b))
    if "div" in j:
        a, b = j["div"]
        return dag.div(expr_from_json(dag, a), expr_from_json(dag, b))
    if "neg" in j:
        return dag.neg(expr_from_json(dag, j["neg"]))
    if "pow" in j:
        base, n = j["pow"]
        return dag.pow(expr_from_json(dag, base), int(n))
    if "cond" in j:
        t, a, b = j["cond"]
        return dag.cond(expr_from_json(dag, t), expr_from_json(dag, a),
                        expr_from_json(dag, b))
    raise ValueError("cannot parse expression JSON: %r" % (j,))


# -- certificates ------------------------------------------------------------

def cert_to_json(cert):
    return {
        "var": cert.var,
        "expr": dag_to_json(cert.dag, cert.root),
        "domain": union_to_json(cert.domain),
        "steps": [
            {
                "action": s["action"],
                "box": interval_to_json(s["box"]),
                "out": [interval_to_json(i) for i in s["out"]],
                "detail": {k: (v if isinstance(v, int) else str(v))
                           for k, v in s["detail"].items()},
            }
            for s in cert.steps
        ],
        "claims": [
            {
                "status": c.status,
                "interval": interval_to_json(c.interval),
                "evidence": {k: (str(v) if not isinstance(v, int) else v)
                             for k, v in c.evidence.items()},
            }
            for c in cert.claims
        ],
    }
