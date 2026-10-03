"""Independent certificate checker.

Verifies, from the certificate alone (plus its embedded problem):

* frontier coverage and disjointness: ``sum`` children partition one
  variable's current domain value-by-value; ``product`` children are
  exactly the connected components of the constraint graph;
* soundness of propagated domains: every node's certified domains lie
  between the independently recomputed AC closure and the pre-propagation
  domains, so no feasible assignment was dropped and no infeasible region
  is counted twice;
* confirmed solutions: singleton solved nodes are checked to actually
  satisfy every constraint; other solved counts are recomputed by
  exhaustive enumeration of the certified domains;
* leaf upper bounds equal the product of the certified domain sizes.

The checker shares only the JSON/digest format with the solver; all
propagation and counting logic here is implemented independently.
"""

from __future__ import annotations

import hashlib
import itertools
import json

MAX_ENUMERATION = 5_000_000


class CertificateError(Exception):
    pass


def _fail(msg):
    raise CertificateError(msg)


def _canonical_problem(data):
    variables = {
        str(k): sorted({int(x) for x in v}) for k, v in data["variables"].items()
    }
    constraints = []
    for c in data.get("constraints", []):
        constraints.append(
            {
                "id": str(c["id"]),
                "scope": [str(v) for v in c["scope"]],
                "tuples": sorted({tuple(int(x) for x in t) for t in c["tuples"]}),
            }
        )
    constraints.sort(key=lambda c: c["id"])
    return {"variables": variables, "constraints": constraints}


def _digest(canonical):
    blob = json.dumps(canonical, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


def _ac_closure(domains, cons):
    """Independently recompute the arc-consistency closure."""
    doms = {v: list(vals) for v, vals in domains.items()}
    queue = [[ci, v] for ci, c in enumerate(cons) for v in c["scope"]]
    while queue:
        ci, var = queue.pop(0)
        c = cons[ci]
        if var not in c["scope"]:
            continue
        scope = c["scope"]
        idx = scope.index(var)
        others = [j for j in range(len(scope)) if j != idx]
        kept = []
        for val in doms[var]:
            ok = False
            for t in c["tuples"]:
                if t[idx] == val and all(t[j] in doms[scope[j]] for j in others):
                    ok = True
                    break
            if ok:
                kept.append(val)
        if len(kept) != len(doms[var]):
            doms[var] = kept
            if not kept:
                return doms
            for cj, c2 in enumerate(cons):
                if cj != ci and var in c2["scope"]:
                    for v2 in c2["scope"]:
                        if v2 != var:
                            queue.append([cj, v2])
    return doms


def _components(vars_, cons):
    adjacency = {v: set() for v in vars_}
    for c in cons:
        for a in c["scope"]:
            for b in c["scope"]:
                if a != b:
                    adjacency[a].add(b)
                    adjacency[b].add(a)
    seen = set()
    out = []
    for v in vars_:
        if v in seen:
            continue
        stack = [v]
        comp = []
        while stack:
            x = stack.pop()
            if x in seen:
                continue
            seen.add(x)
            comp.append(x)
            stack.extend(adjacency[x])
        out.append(frozenset(comp))
    return out


def _enumerate(domains, cons, vars_):
    space = 1
    for v in vars_:
        space *= len(domains[v])
    if space > MAX_ENUMERATION:
        _fail("solved node too large to verify exhaustively")
    tuple_sets = [set(c["tuples"]) for c in cons]
    total = 0
    for vals in itertools.product(*(domains[v] for v in vars_)):
        assign = dict(zip(vars_, vals))
        ok = True
        for c, tset in zip(cons, tuple_sets):
            if tuple(assign[v] for v in c["scope"]) not in tset:
                ok = False
                break
        if ok:
            total += 1
    return total


def _check_node(node, pre, cons_all, path):
    if not isinstance(node, dict):
        _fail("%s: node is not an object" % path)
    kind = node.get("kind")
    vars_ = node.get("vars")
    doms = node.get("domains")
    if not isinstance(vars_, list) or len(set(vars_)) != len(vars_):
        _fail("%s: invalid variable list" % path)
    if not isinstance(doms, dict) or set(doms) != set(vars_):
        _fail("%s: domains do not match variables" % path)
    for v in vars_:
        vals = doms[v]
        if not isinstance(vals, list) or len(set(vals)) != len(vals):
            _fail("%s: duplicate values in domain of %s" % (path, v))
        if v not in pre:
            _fail("%s: unknown variable %s" % (path, v))
    varset = set(vars_)
    cons = [c for c in cons_all if set(c["scope"]) <= varset]
    closure = _ac_closure({v: list(pre[v]) for v in vars_}, cons)
    for v in vars_:
        certified = set(doms[v])
        if not certified <= set(pre[v]):
            _fail("%s: domain of %s exceeds pre-propagation domain" % (path, v))
        if not set(closure[v]) <= certified:
            _fail(
                "%s: domain of %s smaller than the AC closure "
                "(a feasible value may have been dropped)" % (path, v)
            )
    if kind == "leaf":
        ub = 1
        for v in vars_:
            ub *= len(doms[v])
        if node.get("ub") != ub:
            _fail("%s: leaf upper bound is not the domain-size product" % path)
        return (0, ub)
    if kind == "solved":
        count = node.get("count")
        if not isinstance(count, int) or isinstance(count, bool) or count < 0:
            _fail("%s: invalid solved count" % path)
        sizes = [len(doms[v]) for v in vars_]
        if any(s == 0 for s in sizes):
            if count != 0:
                _fail("%s: empty domain but nonzero count" % path)
        elif all(s == 1 for s in sizes):
            if count != 1:
                _fail("%s: singleton node with count != 1" % path)
            assign = {v: doms[v][0] for v in vars_}
            for c in cons:
                if tuple(assign[v] for v in c["scope"]) not in set(c["tuples"]):
                    _fail(
                        "%s: confirmed solution violates constraint %s"
                        % (path, c["id"])
                    )
        else:
            if _enumerate(doms, cons, vars_) != count:
                _fail("%s: solved count fails exhaustive recheck" % path)
        return (count, count)
    if kind == "sum":
        children = node.get("children")
        if not isinstance(children, list) or not children:
            _fail("%s: sum node without children" % path)
        decisions = []
        for ch in children:
            d = ch.get("decision") if isinstance(ch, dict) else None
            if not (isinstance(d, list) and len(d) == 2):
                _fail("%s: sum child missing branch decision" % path)
            decisions.append(d)
        var = decisions[0][0]
        if var not in varset:
            _fail("%s: branch variable not in node scope" % path)
        if any(d[0] != var for d in decisions):
            _fail("%s: sum children branch on different variables" % path)
        values = [d[1] for d in decisions]
        if sorted(values) != sorted(doms[var]):
            _fail(
                "%s: branch values do not partition the domain of %s "
                "(coverage/disjointness violated)" % (path, var)
            )
        lo = hi = 0
        for i, ch in enumerate(children):
            if set(ch.get("vars", [])) != varset:
                _fail("%s: sum child variable set mismatch" % path)
            child_pre = {v: list(doms[v]) for v in vars_}
            child_pre[var] = [decisions[i][1]]
            l, h = _check_node(ch, child_pre, cons_all, "%s/sum[%d]" % (path, i))
            lo += l
            hi += h
        return (lo, hi)
    if kind == "product":
        children = node.get("children")
        if not isinstance(children, list) or len(children) < 2:
            _fail("%s: product node needs at least two children" % path)
        all_vars = []
        for ch in children:
            all_vars += list(ch.get("vars", []))
        if sorted(all_vars) != sorted(vars_):
            _fail("%s: product children do not partition the variables" % path)
        expected = {frozenset(c) for c in _components(sorted(varset), cons)}
        actual = {frozenset(ch["vars"]) for ch in children}
        if expected != actual:
            _fail("%s: product children are not the connected components" % path)
        lo = hi = 1
        for i, ch in enumerate(children):
            child_pre = {v: list(doms[v]) for v in ch["vars"]}
            l, h = _check_node(
                ch, child_pre, cons_all, "%s/product[%d]" % (path, i)
            )
            lo *= l
            hi *= h
        return (lo, hi)
    _fail("%s: unknown node kind %r" % (path, kind))


def _verify(cert):
    if not isinstance(cert, dict) or cert.get("format") != "schcount-certificate/1":
        _fail("not a schcount certificate")
    problem = cert.get("problem")
    if not isinstance(problem, dict) or "variables" not in problem:
        _fail("certificate is missing the problem")
    canonical = _canonical_problem(problem)
    if _digest(canonical) != cert.get("problem_digest"):
        _fail("problem digest mismatch")
    domains = canonical["variables"]
    cons = canonical["constraints"]
    for c in cons:
        if not c["scope"] or len(set(c["scope"])) != len(c["scope"]):
            _fail("malformed constraint scope")
        for v in c["scope"]:
            if v not in domains:
                _fail("constraint %s references unknown variable" % c["id"])
        if not c["tuples"]:
            _fail("constraint %s allows no tuples" % c["id"])
        for t in c["tuples"]:
            if len(t) != len(c["scope"]):
                _fail("constraint %s has a tuple of wrong arity" % c["id"])
            for v, val in zip(c["scope"], t):
                if val not in domains[v]:
                    _fail("constraint %s tuple outside variable domains" % c["id"])
    tree = cert.get("tree")
    if not isinstance(tree, dict):
        _fail("certificate is missing the search tree")
    if set(tree.get("vars", [])) != set(domains):
        _fail("root variables do not match the problem")
    pre = {v: list(domains[v]) for v in sorted(domains)}
    lo, hi = _check_node(tree, pre, cons, "root")
    if (lo, hi) != (cert.get("lower"), cert.get("upper")):
        _fail(
            "certified bounds (%s, %s) do not match the tree interval (%s, %s)"
            % (cert.get("lower"), cert.get("upper"), lo, hi)
        )
    if cert.get("complete") != (lo == hi):
        _fail("complete flag disagrees with the certified bounds")


def verify_certificate(cert):
    """Return ``(ok, reason)``; ``ok`` is True only for a valid certificate."""
    try:
        _verify(cert)
    except CertificateError as exc:
        return (False, str(exc))
    except (KeyError, TypeError, ValueError, IndexError) as exc:
        return (False, "malformed certificate: %s" % exc)
    return (True, "ok")
