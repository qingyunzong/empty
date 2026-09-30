"""Core data model for the nested-scope budget authorizer.

All amounts are integers.  Budgets form a forest (nested scopes); a child
budget shares the quota of its ancestors: any amount allocated to a budget
is attributed to every ancestor exactly once, no matter how many allocated
budgets sit underneath it.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from fnmatch import fnmatchcase


@dataclass
class Budget:
    id: str
    quota: int
    parent: str | None = None


@dataclass
class Rule:
    """An authorization rule: subject + resource condition + time window,
    bound to a (possibly shared) budget, with an optional cumulative limit."""

    id: str
    subject: str          # exact subject or "*"
    resource: str         # fnmatch pattern, e.g. "doc/*"
    start: int            # window start (inclusive)
    end: int              # window end (exclusive)
    budget: str
    limit: int | None = None   # cumulative cap for this rule (None = unbounded)
    used: int = 0

    def matches(self, subject: str, resource: str, now: int) -> bool:
        return (
            (self.subject == "*" or self.subject == subject)
            and fnmatchcase(resource, self.resource)
            and self.start <= now < self.end
        )


# Reservation lifecycle states.
PENDING = "pending"
CONFIRMED = "confirmed"
RELEASED = "released"
EXPIRED = "expired"


@dataclass
class Reservation:
    id: str                       # == request id (one reservation per request)
    subject: str
    resource: str
    amount: int
    allocation: dict[str, int]    # budget id -> amount
    rule_charges: dict[str, int]  # rule id -> amount charged against rule limit
    expiry: int                   # valid while now < expiry
    status: str = PENDING
    created: int = 0


def ancestor_chain(budgets: dict[str, Budget], budget_id: str) -> list[str]:
    """Return [budget_id, parent, ..., root].  Cycles are rejected by the
    engine at construction time, so this always terminates."""
    chain = []
    node = budget_id
    while node is not None:
        chain.append(node)
        node = budgets[node].parent
    return chain
