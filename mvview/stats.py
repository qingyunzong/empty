"""Per-group aggregate state: COUNT(*), NULL-skipping SUM, median, rank."""

from fractions import Fraction

from .ostree import OrderStatTree


class GroupStats:
    """Aggregates for one group of the materialized join view.

    count  -- COUNT(*) over joined tuples (NULL values included)
    total  -- SUM over non-NULL values (exact rational)
    values -- order-statistics tree of the non-NULL values, used for
              median / rank / select without re-sorting history
    """

    def __init__(self):
        self.count = 0
        self.total = Fraction(0)
        self.values = OrderStatTree()

    def add(self, value, delta):
        """Apply a signed delta of `value` (Fraction or None) atomically."""
        if delta == 0:
            return
        new_count = self.count + delta
        if new_count < 0:
            raise ValueError("group count would become negative")
        if value is not None:
            if delta > 0:
                for _ in range(delta):
                    self.values.insert(value)
            else:
                for _ in range(-delta):
                    self.values.remove(value)
        self.count = new_count
        if value is not None:
            self.total += value * delta

    @property
    def sum(self):
        """SUM of non-NULL values, or None when there are none (SQL semantics)."""
        if len(self.values) == 0:
            return None
        return self.total

    @property
    def median(self):
        """Exact rational median of the non-NULL values (None if empty)."""
        n = len(self.values)
        if n == 0:
            return None
        mid = n // 2
        if n % 2 == 1:
            return self.values.select(mid)
        return (self.values.select(mid - 1) + self.values.select(mid)) / 2

    def rank(self, value):
        """Number of non-NULL values strictly smaller than `value`."""
        return self.values.rank(value)

    def select(self, k):
        """k-th smallest non-NULL value (0-based)."""
        return self.values.select(k)
