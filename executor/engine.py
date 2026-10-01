"""Core nested-action executor.

Semantics (see README.md for the full specification):

* An action has an id, a cost, a compensation cost, an outcome
  (``success`` / ``fail`` / ``unsat``) and ordered children.
* ``unsat`` means the precondition can never hold: the action fails
  immediately, costs nothing, runs no children and is never retried.
* ``fail`` consumes the action cost (the attempt happened) but applies no
  effect and runs no children.
* Children execute in declared order.  The first failing child aborts the
  remaining siblings (they are left untouched) and triggers compensation
  of everything already completed, deepest-first.
* Compensation costs budget too.  If the budget cannot pay for the next
  compensation the run ends in BUDGET_EXHAUSTED and the compensation
  sequence is the provably compensated prefix.
* Recovery-order ties are only possible between siblings whose cost AND
  compensation cost are exactly equal; such ties are broken by ascending
  action id.
"""

from __future__ import annotations

from dataclasses import dataclass, field

COMMITTED = "COMMITTED"
ROLLED_BACK = "ROLLED_BACK"
BUDGET_EXHAUSTED = "BUDGET_EXHAUSTED"

OUTCOMES = ("success", "fail", "unsat")


@dataclass
class Action:
    id: str
    cost: int
    compensation_cost: int
    outcome: str = "success"
    children: list = field(default_factory=list)


@dataclass
class Result:
    state: str
    compensations: list
    budget_remaining: int
    executed: list
    events: list

    def to_dict(self):
        return {
            "state": self.state,
            "compensations": list(self.compensations),
            "budget_remaining": self.budget_remaining,
            "executed": list(self.executed),
            "events": [list(e) for e in self.events],
        }


def _tie_class(action):
    return (action.cost, action.compensation_cost)


def compensation_order(children):
    """Deterministic compensation order for completed sibling subtrees.

    Base rule: reverse completion order.  Siblings whose cost and
    compensation cost are exactly equal form a tie class; the class keeps
    the position of its last-completed member and its members are ordered
    by ascending action id (rule 4 of the spec).
    """
    if not children:
        return []
    class_pos = {}
    for index, child in enumerate(children):
        key = _tie_class(child)
        if key not in class_pos or index > class_pos[key]:
            class_pos[key] = index
    return sorted(children, key=lambda c: (-class_pos[_tie_class(c)], c.id))


class Executor:
    def __init__(self, root, budget):
        self.root = root
        self.budget = budget
        self.compensations = []
        self.executed = []
        self.events = []
        self.exhausted = False

    def run(self):
        ok = self._execute(self.root)
        if ok:
            state = COMMITTED
        elif self.exhausted:
            state = BUDGET_EXHAUSTED
        else:
            state = ROLLED_BACK
        return Result(
            state=state,
            compensations=list(self.compensations),
            budget_remaining=self.budget,
            executed=list(self.executed),
            events=list(self.events),
        )

    def _execute(self, action):
        if action.outcome == "unsat":
            # Precondition can never hold: fail fast, no cost, no retry.
            self.events.append(("unsat", action.id))
            return False
        if self.budget < action.cost:
            # Cannot afford to start the action: treated as a failure;
            # already-completed ancestors/siblings are rolled back.
            self.events.append(("budget_shortfall", action.id))
            return False
        self.budget -= action.cost
        if action.outcome == "fail":
            self.events.append(("fail", action.id))
            return False
        self.executed.append(action.id)
        self.events.append(("execute", action.id))
        completed = []
        for child in action.children:
            if self._execute(child):
                completed.append(child)
            else:
                # Later siblings are never started; roll back exactly the
                # completed prefix of this subtree, deepest first.
                self._compensate_completed(action, completed)
                return False
        return True

    def _compensate_completed(self, action, completed_children):
        for child in compensation_order(completed_children):
            if self.exhausted:
                return
            self._compensate_subtree(child)
        self._compensate_node(action)

    def _compensate_subtree(self, action):
        # ``action`` completed fully, so all of its children completed.
        for child in compensation_order(action.children):
            if self.exhausted:
                return
            self._compensate_subtree(child)
        self._compensate_node(action)

    def _compensate_node(self, action):
        if self.exhausted:
            return
        if self.budget < action.compensation_cost:
            self.exhausted = True
            self.events.append(("budget_exhausted", action.id))
            return
        self.budget -= action.compensation_cost
        self.compensations.append(action.id)
        self.events.append(("compensate", action.id))
