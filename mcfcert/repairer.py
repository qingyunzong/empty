"""Budgeted repair of broken min-cost flow certificates.

Given a network and a submitted (possibly infeasible) base flow, the
repairer searches for a feasible flow that is lexicographically minimal in

1. the number of edges whose flow differs from the base flow,
2. the L1 distance to the base flow,
3. the total cost of the repaired flow.

A step budget bounds the search.  When the budget runs out the repairer
returns the best feasible repair found so far together with a proven lower
bound on the number of modifications, and explicitly does not claim
optimality.  When the network admits no feasible flow at all, a cut
certificate (Hoffman-style) is returned instead.
"""

from itertools import combinations

from . import flow as flowlib


class BudgetExhausted(Exception):
    """Internal control flow raised when the step budget runs out."""


class Repairer:
    """Repairs submitted flows for one fixed network."""

    def __init__(self, network):
        self._network = network

    @property
    def network(self):
        return self._network

    def repair(self, base_flows, budget=None, checkpoint=None):
        """Repair ``base_flows`` (a dict edge_id -> integer flow).

        ``budget`` caps the number of search steps (subset feasibility tests
        and min-cost-flow solves); ``None`` means unlimited.  ``checkpoint``,
        when given, is called with a progress dict at each phase boundary.
        Returns a JSON-serialisable result dict.
        """
        net = self._network
        unknown = set(base_flows) - {e.id for e in net.edges}
        if unknown:
            raise ValueError(f"unknown edge ids in base flow: {sorted(unknown)}")
        base = {}
        for edge in net.edges:
            if edge.id not in base_flows:
                raise ValueError(f"missing flow for edge {edge.id!r}")
            value = base_flows[edge.id]
            if isinstance(value, bool) or not isinstance(value, int):
                raise ValueError(f"flow for edge {edge.id!r} must be an integer")
            base[edge.id] = value
        if budget is not None and budget < 0:
            raise ValueError("budget must be non-negative or None")
        return _Repair(net, base, budget, checkpoint).run()


class _Repair:
    def __init__(self, net, base, budget, checkpoint):
        self.net = net
        self.base = base
        self.budget = budget
        self.checkpoint = checkpoint
        self.steps = 0
        self.status = "budget_exhausted"
        self.lower_bound = 0
        self.cut = None
        self.best = None  # ((modifications, l1, cost), flows)
        self.feasible_subsets = None
        # Any two feasible flows differ in cost by at most this, so weighting
        # one L1 unit by cost_range + 1 makes the weighted single-criterion
        # solve exactly lexicographic in (L1, cost).
        self.cost_range = sum(abs(e.cost) * (e.upper - e.lower) for e in net.edges)

    # -- driver ---------------------------------------------------------

    def run(self):
        try:
            self._phase_feasibility()
            if self.status != "infeasible":
                self._phase_modifications()
                self._phase_polish()
                self.status = "optimal"
        except BudgetExhausted:
            self.status = "budget_exhausted"
        self._emit("done")
        return self._result()

    def _spend(self):
        if self.budget is not None and self.steps >= self.budget:
            raise BudgetExhausted
        self.steps += 1

    # -- phases ----------------------------------------------------------

    def _phase_feasibility(self):
        """Any feasible flow: early incumbent and infeasibility detection."""
        self._spend()
        net = self.net
        arcs = [
            (net.node_index(e.tail), net.node_index(e.head), e.lower, e.upper)
            for e in net.edges
        ]
        balances = [net.demand(n) for n in net.nodes]
        flows, reach = flowlib.feasible_flow(len(net.nodes), arcs, balances)
        if flows is None:
            self.status = "infeasible"
            self.cut = self._cut_certificate(reach)
            self._emit("infeasible")
            return
        self._consider(self._to_dict(flows))
        self._emit("feasibility")

    def _phase_modifications(self):
        """Smallest k such that some k-subset of edges admits a repair."""
        count = len(self.net.edges)
        for k in range(count + 1):
            found = []
            for subset in combinations(range(count), k):
                self._spend()
                flows = self._subset_flow(subset)
                if flows is not None:
                    found.append(subset)
                    self._consider(flows)
            if found:
                self.feasible_subsets = found
                self.lower_bound = k
                self._emit("modifications", level=k)
                return
            self.lower_bound = k + 1
            self._emit("modifications", level=k)
        raise AssertionError("the full edge set always admits a feasible flow")

    def _phase_polish(self):
        """Per minimal subset, solve the weighted (L1, cost) min-cost flow."""
        for subset in self.feasible_subsets:
            self._spend()
            flows = self._subset_weighted_flow(subset)
            self._consider(flows)
        self._emit("objective")

    # -- subproblems ------------------------------------------------------

    def _subset_flow(self, subset):
        """Feasible flow that may only deviate from the base on ``subset``."""
        net = self.net
        free = set(subset)
        arcs = []
        for i, edge in enumerate(net.edges):
            u = net.node_index(edge.tail)
            v = net.node_index(edge.head)
            if i in free:
                arcs.append((u, v, edge.lower, edge.upper))
            else:
                x0 = self.base[edge.id]
                if x0 < edge.lower or x0 > edge.upper:
                    return None  # unchangeable edge already violates its bounds
                arcs.append((u, v, x0, x0))
        balances = [net.demand(n) for n in net.nodes]
        flows, _ = flowlib.feasible_flow(len(net.nodes), arcs, balances)
        if flows is None:
            return None
        return self._to_dict(flows)

    def _subset_weighted_flow(self, subset):
        """Min (L1, cost) lexicographic repair deviating only on ``subset``.

        Each free edge is rebased to clamp(x0, lower, upper); a forward
        residual arc (cost W + c) and a backward residual arc (cost W - c)
        with W = cost_range + 1 encode one L1 unit plus the cost delta, so
        the plain min-cost flow optimises (L1, cost) lexicographically.
        """
        net = self.net
        weight = self.cost_range + 1
        free = set(subset)
        arcs = []
        balances = [net.demand(n) for n in net.nodes]
        for i, edge in enumerate(net.edges):
            u = net.node_index(edge.tail)
            v = net.node_index(edge.head)
            x0 = self.base[edge.id]
            if i in free:
                b0 = min(max(x0, edge.lower), edge.upper)
                arcs.append((u, v, 0, edge.upper - b0, weight + edge.cost))
                arcs.append((v, u, 0, b0 - edge.lower, weight - edge.cost))
            else:
                b0 = x0
            balances[u] += b0
            balances[v] -= b0
        flows, _ = flowlib.min_cost_flow(len(net.nodes), arcs, balances)
        if flows is None:
            raise AssertionError("subset proven feasible but weighted solve failed")
        result = {}
        j = 0
        for i, edge in enumerate(net.edges):
            if i in free:
                x0 = self.base[edge.id]
                b0 = min(max(x0, edge.lower), edge.upper)
                result[edge.id] = b0 + flows[j] - flows[j + 1]
                j += 2
            else:
                result[edge.id] = self.base[edge.id]
        return result

    # -- bookkeeping ------------------------------------------------------

    def _to_dict(self, flows):
        return {edge.id: value for edge, value in zip(self.net.edges, flows)}

    def _evaluate(self, flows):
        net = self.net
        modifications = 0
        l1 = 0
        cost = 0
        divergence = {node: 0 for node in net.nodes}
        for edge in net.edges:
            x = flows[edge.id]
            if not (edge.lower <= x <= edge.upper):
                raise AssertionError("internal error: repair violates edge bounds")
            x0 = self.base[edge.id]
            if x != x0:
                modifications += 1
            l1 += abs(x - x0)
            cost += x * edge.cost
            divergence[edge.tail] -= x
            divergence[edge.head] += x
        for node in net.nodes:
            if divergence[node] != net.demand(node):
                raise AssertionError("internal error: repair violates demands")
        return (modifications, l1, cost)

    def _consider(self, flows):
        triple = self._evaluate(flows)
        if self.best is None or triple < self.best[0]:
            self.best = (triple, dict(flows))

    def _cut_certificate(self, reach):
        """Hoffman cut: the nodes NOT reachable from the super source.

        For the unreachable set S, net demand exceeds the maximum net inflow
        across the cut, which proves infeasibility.
        """
        net = self.net
        cut_set = {node for i, node in enumerate(net.nodes) if i not in reach}
        net_demand = sum(net.demand(n) for n in cut_set)
        in_capacity = sum(
            e.upper for e in net.edges if e.head in cut_set and e.tail not in cut_set
        )
        out_lower = sum(
            e.lower for e in net.edges if e.tail in cut_set and e.head not in cut_set
        )
        max_net_inflow = in_capacity - out_lower
        return {
            "nodes": sorted(cut_set),
            "net_demand": net_demand,
            "max_net_inflow": max_net_inflow,
            "deficit": net_demand - max_net_inflow,
            "explanation": (
                "net demand of the cut exceeds the maximum net inflow "
                "across it, so no feasible flow exists"
            ),
        }

    def _emit(self, event, **extra):
        if self.checkpoint is None:
            return
        payload = {
            "event": event,
            "steps": self.steps,
            "lower_bound_modifications": self.lower_bound,
            "incumbent": None
            if self.best is None
            else {
                "modifications": self.best[0][0],
                "l1_distance": self.best[0][1],
                "cost": self.best[0][2],
            },
        }
        payload.update(extra)
        self.checkpoint(payload)

    def _result(self):
        if self.best is not None:
            (modifications, l1, cost), flows = self.best
        else:
            modifications = l1 = cost = None
            flows = None
        return {
            "status": self.status,
            "optimal": self.status == "optimal",
            "flows": flows,
            "modifications": modifications,
            "l1_distance": l1,
            "cost": cost,
            "lower_bound_modifications": None
            if self.status == "infeasible"
            else self.lower_bound,
            "cut": self.cut,
            "steps_used": self.steps,
            "budget": self.budget,
        }
