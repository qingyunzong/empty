"""Independent certificate verification for min-cost flow solutions.

The verifier is deliberately self-contained: it never calls the repairer or
any optimisation routine beyond plain residual-graph cycle detection, so a
buggy or malicious repairer cannot launder a bad certificate.
"""

from . import flow as flowlib


def _is_int(value):
    return isinstance(value, int) and not isinstance(value, bool)


class Verifier:
    """Reusable, stateless verifier bound to a single network.

    Every ``verify`` call builds a fresh verdict from the network and the
    certificate alone; no state leaks between calls, so batches of
    certificates over a shared network are checked independently.
    """

    def __init__(self, network):
        self._network = network

    @property
    def network(self):
        return self._network

    def verify(self, certificate):
        net = self._network
        flows, capacity_violations, computable = self._check_capacity(
            net, certificate
        )
        conservation_violations = self._check_conservation(net, flows)
        demand_violations = self._check_demands(net)
        cost_info = self._check_cost(net, certificate, flows, computable)
        reduced_violations, potentials_ok = self._check_reduced_costs(
            net, certificate, flows, computable
        )
        cycle_info = self._find_negative_cycle(net, flows, computable)

        checks = {
            "capacity": {
                "ok": not capacity_violations,
                "violations": capacity_violations,
            },
            "conservation": {
                "ok": not conservation_violations,
                "violations": conservation_violations,
            },
            "demand": {
                "ok": not demand_violations,
                "violations": demand_violations,
            },
            "cost": cost_info,
            "reduced_costs": {
                "ok": not reduced_violations,
                "violations": reduced_violations,
            },
        }
        valid = (
            all(info["ok"] for info in checks.values())
            and potentials_ok
            and not cycle_info.get("found", False)
        )
        return {"valid": valid, "checks": checks, "negative_cycle": cycle_info}

    def _check_capacity(self, net, certificate):
        flows = {}
        violations = []
        computable = True
        for edge in net.edges:
            value = certificate.flows.get(edge.id)
            if value is None:
                violations.append({"edge": edge.id, "reason": "missing flow"})
                flows[edge.id] = None
                computable = False
            elif not _is_int(value):
                violations.append(
                    {"edge": edge.id, "flow": value, "reason": "non-integer flow"}
                )
                flows[edge.id] = None
                computable = False
            else:
                flows[edge.id] = value
                if value < edge.lower or value > edge.upper:
                    violations.append(
                        {
                            "edge": edge.id,
                            "flow": value,
                            "lower": edge.lower,
                            "upper": edge.upper,
                            "reason": "out of bounds",
                        }
                    )
        return flows, violations, computable

    def _check_conservation(self, net, flows):
        divergence = {node: 0 for node in net.nodes}
        for edge in net.edges:
            value = flows[edge.id]
            if value is None:
                continue
            divergence[edge.tail] -= value
            divergence[edge.head] += value
        violations = []
        for node in net.nodes:
            required = net.demand(node)
            actual = divergence[node]
            if actual != required:
                violations.append(
                    {"node": node, "required": required, "actual": actual}
                )
        return violations

    def _check_demands(self, net):
        imbalance = sum(net.demands.values())
        if imbalance == 0:
            return []
        return [
            {
                "imbalance": imbalance,
                "reason": "demands do not sum to zero; no feasible flow exists",
            }
        ]

    def _check_cost(self, net, certificate, flows, computable):
        actual = None
        if computable:
            actual = sum(flows[e.id] * e.cost for e in net.edges)
        declared = certificate.declared_cost
        info = {"declared": declared, "actual": actual}
        if declared is None:
            info["ok"] = False
            info["reason"] = "missing declared cost"
        elif not _is_int(declared):
            info["ok"] = False
            info["reason"] = "non-integer declared cost"
        elif actual is None:
            info["ok"] = False
            info["reason"] = "actual cost not computable from the given flows"
        else:
            info["ok"] = declared == actual
        return info

    def _check_reduced_costs(self, net, certificate, flows, computable):
        potentials = {}
        violations = []
        potentials_ok = True
        for node in net.nodes:
            value = certificate.potentials.get(node)
            if value is None:
                violations.append({"node": node, "reason": "missing potential"})
                potentials_ok = False
            elif not _is_int(value):
                violations.append(
                    {"node": node, "potential": value, "reason": "non-integer potential"}
                )
                potentials_ok = False
            else:
                potentials[node] = value
        if potentials_ok and computable:
            for edge in net.edges:
                x = flows[edge.id]
                if x < edge.lower or x > edge.upper:
                    continue  # residual arcs ill-defined; already reported
                pi_tail = potentials[edge.tail]
                pi_head = potentials[edge.head]
                if x < edge.upper:
                    rc = edge.cost + pi_tail - pi_head
                    if rc < 0:
                        violations.append(
                            {
                                "edge": edge.id,
                                "direction": "forward",
                                "reduced_cost": rc,
                            }
                        )
                if x > edge.lower:
                    rc = -edge.cost + pi_head - pi_tail
                    if rc < 0:
                        violations.append(
                            {
                                "edge": edge.id,
                                "direction": "backward",
                                "reduced_cost": rc,
                            }
                        )
        return violations, potentials_ok

    def _find_negative_cycle(self, net, flows, computable):
        if not computable or any(
            flows[e.id] < e.lower or flows[e.id] > e.upper for e in net.edges
        ):
            return {
                "found": None,
                "skipped": True,
                "reason": "capacity violations make the residual graph undefined",
            }
        arcs = []
        labels = []
        for edge in net.edges:
            x = flows[edge.id]
            tail = net.node_index(edge.tail)
            head = net.node_index(edge.head)
            if x < edge.upper:
                arcs.append((tail, head, edge.cost))
                labels.append((edge.id, "forward"))
            if x > edge.lower:
                arcs.append((head, tail, -edge.cost))
                labels.append((edge.id, "backward"))
        cycle = flowlib.negative_cycle_from_arcs(len(net.nodes), arcs)
        if cycle is None:
            return {"found": False}
        return {
            "found": True,
            "edges": [labels[k][0] for k in cycle],
            "directions": [labels[k][1] for k in cycle],
            "cost": sum(arcs[k][2] for k in cycle),
        }
