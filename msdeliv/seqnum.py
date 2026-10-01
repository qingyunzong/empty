"""Cyclic sequence-number arithmetic.

Sequence numbers live in ``Z/mod``.  A comparison between two sequence
numbers is only meaningful when their forward distance is known to be
small; therefore all classification is done relative to an explicit
window anchored at the next expected sequence number:

  * offset ``d = (seq - base) mod mod``
  * ``0 <= d < window``            -> inside the receive window
  * ``mod - window <= d < mod``    -> unambiguously in the past (old)
  * anything else                  -> ambiguous, comparison is invalid

The ambiguous band exists because with cyclic numbers a far-ahead
"future" value and a far-behind "past" value are indistinguishable
without extra state; frames landing there must be rejected, never
ordered by plain integer comparison.
"""

PAST = "past"
WINDOW = "window"
AMBIGUOUS = "ambiguous"


def check_window_params(mod, window):
    if not isinstance(mod, int) or mod <= 0 or (mod & (mod - 1)) != 0:
        raise ValueError("mod must be a positive power of two")
    if not isinstance(window, int) or window <= 0 or 2 * window >= mod:
        raise ValueError("need 0 < 2*window < mod for unambiguous comparison")


def fwd_dist(a, b, mod):
    """Forward distance from ``a`` to ``b`` on the cycle of size ``mod``."""
    return (b - a) % mod


def classify(seq, base, mod, window):
    """Classify ``seq`` relative to ``base`` (the next expected number)."""
    check_window_params(mod, window)
    d = (seq - base) % mod
    if d < window:
        return WINDOW
    if d >= mod - window:
        return PAST
    return AMBIGUOUS
