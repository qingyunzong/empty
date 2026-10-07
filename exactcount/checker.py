"""Independent certificate checker.

Deliberately does not import the solver.  Verifies, from the certificate
alone:

* every domain reduction is sound (each removed value is unsupported within
  the recorded domains, given the branch decisions);
* branch children partition their parent's remaining space and decompose
  children factor the space along independent constraint-graph components;
* every confirmed solution leaf satisfies all constraints of its subproblem;
* the unexplored frontier covers the remaining space, is pairwise disjoint,
  and its sizes exactly account for certified_upper - confirmed_lower;
* the claimed bounds match the recomputed ones.
"""

from __future__ import annotations

import itertools
import json

FORMAT = "exactcount-certificate-1"
MAX_ERRORS = 25


class _Abort(Exception):
    pass


def verify_certificate(cert):
    """Return a list of error strings; empty list means the proof is valid."""
    errors = []
    try:
        _Checker(cert, errors).run()
    except _Abort:
        pass
    except Exception as exc:  # malformed input must never crash the checker
        errors.append("malformed certificate: %r" % (exc,))
    return errors


def frontier_spaces_disjoint(space_a, space_b):
    """Two assignment spaces (var -> allowed values) are disjoint iff some
    variable has disjoint value sets in both."""
    if set(space_a) != set(space_b):
        raise ValueError("spaces described over different variables")
    return any(set(space_a[v]).isdisjoint(space_b[v]) for v in space_a)


class _Checker:
    def __init__(self, cert, errors):
        self.cert = cert
        self.errors = errors
        self.cmap = {}
        self.variables = {}

    def error(self, msg):
        self.errors.append(msg)
        if len(self.errors) >= MAX_ERRORS:
            raise _Abort()

    # ------------------------------------------------------------- top level

    def run(self):
        cert = self.cert
        if not isinstance(cert, dict):
            self.error("certificate is not a JSON object")
            raise _Abort()
        if cert.get("format") != FORMAT:
            self.error("unknown or missing certificate format")
            raise _Abort()
        self.variables, self.cmap = self._check_problem(cert.get("problem"))

        for field in ("confirmed_lower", "certified_upper"):
            value = cert.get(field)
            if isinstance(value, bool) or not isinstance(value, int) or value < 0:
                self.error(f"{field} is not a non-negative integer")
                raise _Abort()
        if not isinstance(cert.get("complete"), bool):
            self.error("complete flag is missing or not a boolean")
            raise _Abort()

        tree = cert.get("tree")
        if not isinstance(tree, dict):
            self.error("certificate has no search tree")
            raise _Abort()

        all_vars = sorted(self.variables)
        all_cids = sorted(self.cmap)
        lower, upper, frontier = self.check_node(
            tree, {}, self.variables, all_vars, all_cids, {}
        )

        if lower != cert["confirmed_lower"]:
            self.error(
                f"confirmed_lower mismatch: claimed {cert['confirmed_lower']}, "
                f"recomputed {lower}"
            )
        if upper != cert["certified_upper"]:
            self.error(
                f"certified_upper mismatch: claimed {cert['certified_upper']}, "
                f"recomputed {upper}"
            )
        has_frontier = bool(frontier)
        if cert["complete"] != (not has_frontier):
            self.error(
                f"complete flag {cert['complete']} inconsistent with "
                f"frontier of size {len(frontier)}"
            )
        if not has_frontier and lower != upper:
            self.error("complete certificate with lower != upper")

        self._check_frontier(cert.get("frontier"), frontier, lower, upper)

    def _check_problem(self, problem):
        if not isinstance(problem, dict):
            self.error("problem is missing")
            raise _Abort()
        raw_vars = problem.get("variables")
        if not isinstance(raw_vars, dict) or not raw_vars:
            self.error("problem.variables is missing or empty")
            raise _Abort()
        variables = {}
        for name, values in raw_vars.items():
            if (
                not isinstance(values, list)
                or not values
                or any(isinstance(v, bool) or not isinstance(v, int) for v in values)
                or len(set(values)) != len(values)
            ):
                self.error(f"variable {name!r} has an invalid domain")
                raise _Abort()
            variables[str(name)] = sorted(values)
        cmap = {}
        for c in problem.get("constraints", []):
            try:
                cid = int(c["id"])
                scope = [str(s) for s in c["scope"]]
                tuples = [list(t) for t in c["tuples"]]
                version = int(c.get("version", 1))
            except (KeyError, TypeError, ValueError):
                self.error("malformed constraint entry")
                raise _Abort()
            if cid in cmap:
                self.error(f"duplicate constraint id {cid}")
                raise _Abort()
            if not scope or len(set(scope)) != len(scope):
                self.error(f"constraint {cid} has an invalid scope")
                raise _Abort()
            for s in scope:
                if s not in variables:
                    self.error(f"constraint {cid} uses unknown variable {s!r}")
                    raise _Abort()
            norm = set()
            for t in tuples:
                if len(t) != len(scope):
                    self.error(f"constraint {cid} has a tuple of wrong arity")
                    raise _Abort()
                for value, var in zip(t, scope):
                    if value not in variables[var]:
                        self.error(
                            f"constraint {cid} tuple value outside domain of {var!r}"
                        )
                        raise _Abort()
                norm.add(tuple(t))
            cmap[cid] = {
                "id": cid,
                "version": version,
                "scope": scope,
                "tuples": sorted(norm),
            }
        return variables, cmap

    # ------------------------------------------------------------------ nodes

    def check_node(self, node, decisions, parent_domains, context, cids, fullmap):
        """Returns (lower, upper, frontier_list) for the subtree."""
        if not isinstance(node, dict):
            self.error("tree node is not an object")
            raise _Abort()
        kind = node.get("type")
        if kind not in ("frontier", "branch", "decompose", "solution", "dead", "free"):
            self.error(f"unknown node type {kind!r}")
            raise _Abort()
        if sorted(node.get("context", [])) != sorted(context):
            self.error(f"node context mismatch at {kind} node")
            raise _Abort()
        if sorted(node.get("cids", [])) != sorted(cids):
            self.error(f"node constraint set mismatch at {kind} node")
            raise _Abort()
        domains = node.get("domains")
        if not isinstance(domains, dict):
            self.error(f"{kind} node has no domains")
            raise _Abort()

        relevant = set(context)
        for cid in cids:
            relevant.update(self.cmap[cid]["scope"])
        if set(domains) != relevant:
            self.error(
                f"{kind} node domains cover {sorted(domains)}, "
                f"expected {sorted(relevant)}"
            )
            raise _Abort()
        for var, dom in domains.items():
            if (
                not isinstance(dom, list)
                or any(isinstance(v, bool) or not isinstance(v, int) for v in dom)
                or len(set(dom)) != len(dom)
                or dom != sorted(dom)
            ):
                self.error(f"{kind} node: invalid domain for {var!r}")
                raise _Abort()
            if var not in parent_domains or not set(dom) <= set(parent_domains[var]):
                self.error(f"{kind} node: domain of {var!r} escapes parent domain")
                raise _Abort()
            if kind != "dead" and not dom:
                self.error(f"{kind} node: empty domain for {var!r}")
                raise _Abort()
        for var, value in decisions.items():
            if var in domains and domains[var] != [value]:
                self.error(
                    f"{kind} node: decided variable {var!r} is not fixed to {value}"
                )
                raise _Abort()

        # Soundness of every removed value (this also justifies dead ends).
        for var, dom in domains.items():
            present = set(dom)
            for value in parent_domains[var]:
                if value not in present and not self._unsupported(
                    cids, var, value, domains
                ):
                    self.error(
                        f"{kind} node: value {value} of {var!r} was removed "
                        f"but still has support"
                    )

        full = dict(fullmap)
        full.update(domains)

        if kind == "frontier":
            upper = 1
            for v in context:
                upper *= len(domains[v])
            return 0, upper, [{"domains": {v: list(full[v]) for v in sorted(full)}}]
        if kind == "dead":
            if not any(not domains[v] for v in context):
                self.error("dead node without an emptied domain")
            return 0, 0, []
        if kind == "solution":
            for v in context:
                if len(domains[v]) != 1:
                    self.error("solution node with a non-singleton domain")
                    raise _Abort()
            for cid in cids:
                c = self.cmap[cid]
                if any(len(domains[s]) != 1 for s in c["scope"]):
                    self.error("solution node: constraint scope not fully assigned")
                    raise _Abort()
                t = tuple(domains[s][0] for s in c["scope"])
                if t not in set(map(tuple, c["tuples"])):
                    self.error(f"solution leaf violates constraint {cid}")
            return 1, 1, []
        if kind == "free":
            count = 1
            for v in context:
                count *= len(domains[v])
            if node.get("count") != count:
                self.error(
                    f"free leaf claims count {node.get('count')}, recomputed {count}"
                )
            for cid in cids:
                c = self.cmap[cid]
                scope = c["scope"]
                open_scope = [s for s in scope if len(domains[s]) > 1]
                if not set(open_scope) <= set(context):
                    self.error(
                        f"free leaf: constraint {cid} has open variables outside "
                        f"the leaf context"
                    )
                    raise _Abort()
                allowed = set(map(tuple, c["tuples"]))
                fixed = {s: domains[s][0] for s in scope if len(domains[s]) == 1}
                for combo in itertools.product(*(domains[s] for s in open_scope)):
                    assignment = dict(fixed)
                    assignment.update(zip(open_scope, combo))
                    if tuple(assignment[s] for s in scope) not in allowed:
                        self.error(
                            f"free leaf: constraint {cid} rejects a combination "
                            f"counted as feasible"
                        )
                        break
            return count, count, []
        if kind == "branch":
            var = node.get("var")
            if var not in context:
                self.error("branch node variable not in context")
                raise _Abort()
            values = domains[var]
            if len(values) < 2:
                self.error("branch node on a singleton domain")
                raise _Abort()
            children = node.get("children")
            if not isinstance(children, list) or len(children) != len(values):
                self.error("branch children do not match the branched domain")
                raise _Abort()
            lo = hi = 0
            frontier = []
            for value, child in zip(values, children):
                child_decisions = dict(decisions)
                child_decisions[var] = value
                c_lo, c_hi, c_fr = self.check_node(
                    child, child_decisions, domains, context, cids, full
                )
                lo += c_lo
                hi += c_hi
                frontier.extend(c_fr)
            return lo, hi, frontier
        # decompose
        children = node.get("children")
        if not isinstance(children, list) or not children:
            self.error("decompose node without children")
            raise _Abort()
        open_vars = sorted(v for v in context if len(domains[v]) > 1)
        seen = set()
        child_contexts = []
        for child in children:
            cc = sorted(child.get("context", []))
            for v in cc:
                if v in seen:
                    self.error("decompose children have overlapping contexts")
                    raise _Abort()
                seen.add(v)
            child_contexts.append(cc)
        if seen != set(open_vars):
            self.error("decompose children do not partition the open variables")
            raise _Abort()
        # Each constraint's open scope must lie inside exactly one child.
        child_cids = [[] for _ in children]
        for cid in cids:
            c = self.cmap[cid]
            oscope = [s for s in c["scope"] if len(domains[s]) > 1]
            if not oscope:
                t = tuple(domains[s][0] for s in c["scope"])
                if t not in set(map(tuple, c["tuples"])):
                    self.error(f"decompose node: decided constraint {cid} violated")
                continue
            home = None
            for idx, cc in enumerate(child_contexts):
                if set(oscope) <= set(cc):
                    home = idx
                    break
            if home is None:
                self.error(
                    f"decompose node: constraint {cid} spans multiple components"
                )
                raise _Abort()
            child_cids[home].append(cid)
        lo = hi = 1
        frontier = []
        for child, cc, expected_cids in zip(children, child_contexts, child_cids):
            c_lo, c_hi, c_fr = self.check_node(
                child, decisions, domains, cc, sorted(expected_cids), full
            )
            lo *= c_lo
            hi *= c_hi
            frontier.extend(c_fr)
        return lo, hi, frontier

    # ---------------------------------------------------------------- helpers

    def _unsupported(self, cids, var, value, domains):
        """True iff some constraint over ``var`` offers no supporting tuple."""
        for cid in cids:
            c = self.cmap[cid]
            scope = c["scope"]
            if var not in scope:
                continue
            idx = scope.index(var)
            supported = False
            for t in c["tuples"]:
                if t[idx] != value:
                    continue
                if all(t[j] in domains[s] for j, s in enumerate(scope)):
                    supported = True
                    break
            if not supported:
                return True
        return False

    def _check_frontier(self, cert_frontier, frontier, lower, upper):
        if not isinstance(cert_frontier, list):
            self.error("certificate frontier is missing")
            return
        try:
            claimed = sorted(json.dumps(e, sort_keys=True) for e in cert_frontier)
        except (TypeError, ValueError):
            self.error("certificate frontier is not JSON-serializable")
            return
        recomputed = sorted(json.dumps(e, sort_keys=True) for e in frontier)
        if claimed != recomputed:
            self.error("frontier list does not match the search tree")
            return
        spaces = [entry["domains"] for entry in frontier]
        for i in range(len(spaces)):
            for j in range(i + 1, len(spaces)):
                if not frontier_spaces_disjoint(spaces[i], spaces[j]):
                    self.error(
                        f"frontier nodes {i} and {j} overlap: assignment space "
                        f"is counted more than once"
                    )
        total = 0
        for space in spaces:
            size = 1
            for values in space.values():
                size *= len(values)
            total += size
        if total != upper - lower:
            self.error(
                f"frontier does not cover the gap: sizes sum to {total}, "
                f"but certified_upper - confirmed_lower = {upper - lower}"
            )
