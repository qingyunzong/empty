"""Operation budget for isolation/refinement.

Budget units (as required by the spec):

* ``remainders``  -- one unit per signed-remainder step when building a
  Sturm sequence (符号余式).
* ``bisections``  -- one unit per interval bisection (二分), both during
  isolation and during refinement.

When the budget is exhausted a :class:`BudgetExhausted` exception is raised
*before* the operation is performed, so the caller can save a consistent
frontier and resume later without duplicating or losing roots.
"""


class BudgetExhausted(Exception):
    """Raised when an operation would exceed the remaining budget."""


class Budget:
    def __init__(self, limit=None, stats=None):
        # limit=None means unlimited.
        self.limit = limit
        self.used = 0
        self.stats = stats if stats is not None else {"remainders": 0, "bisections": 0}

    def consume(self, kind, n=1):
        if self.limit is not None and self.used + n > self.limit:
            raise BudgetExhausted(
                "budget exhausted: need %d more %s operation(s)" % (n, kind)
            )
        self.used += n
        self.stats[kind] = self.stats.get(kind, 0) + n
