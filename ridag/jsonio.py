"""JSON (de)serialization for expressions, intervals and certificates."""

from fractions import Fraction

from .intervals import Interval, MINF, PINF, mkset


def bound_to_json(v):
    if v is MINF:
        return "-inf"
    if v is PINF:
        return "inf"
    return str(v)


def bound_from_json(s):
    if s == "inf":
        return PINF
    if s == "-inf":
        return MINF
    return Fraction(s)


def interval_to_json(i):
    return [bound_to_json(i.lo), bound_to_json(i.hi), i.lc, i.hc]


def interval_from_json(j):
    return Interval(bound_from_json(j[0]), bound_from_json(j[1]),
                    bool(j[2]), bool(j[3]))


def set_to_json(s):
    return [interval_to_json(i) for i in s]


def set_from_json(j):
    return mkset([interval_from_json(x) for x in j])


def expr_from_json(ctx, j):
    op = j["op"]
    if op == "const":
        return ctx.const(Fraction(j["value"]))
    if op == "var":
        return ctx.var(j["name"])
    if op in ("add", "sub", "mul", "div"):
        a = expr_from_json(ctx, j["args"][0])
        b = expr_from_json(ctx, j["args"][1])
        return getattr(ctx, op)(a, b)
    if op == "pow":
        return ctx.powi(expr_from_json(ctx, j["arg"]), int(j["exp"]))
    if op == "if":
        return ctx.if_(expr_from_json(ctx, j["cond"]),
                       expr_from_json(ctx, j["then"]),
                       expr_from_json(ctx, j["else"]))
    raise ValueError("unknown op %r" % (op,))


def proof_to_json(p):
    out = {}
    for k, v in p.items():
        if isinstance(v, Fraction):
            out[k] = str(v)
        elif isinstance(v, Interval):
            out[k] = interval_to_json(v)
        else:
            out[k] = v
    return out


def output_to_json(o):
    return {"interval": interval_to_json(o.interval), "label": o.label}


def cert_to_json(o):
    return {"label": o.label,
            "interval": interval_to_json(o.interval),
            "chain": [interval_to_json(i) for i in o.chain],
            "proof": proof_to_json(o.proof)}
