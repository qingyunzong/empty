"""Isolation-evidence cache with checkpoint save/restore.

Every entry restored from a checkpoint is fully re-verified with exact
arithmetic (Sturm root counts, exact polynomial signs, interval
containment, and consistency of cached results with the certified
interval).  Any tampering raises :class:`EvidenceError`.
"""
import json
from fractions import Fraction

from .polys import (
    frac_ceil,
    frac_floor,
    round_half_even_fraction,
    sign_at_fraction,
    squarefree_part,
    sturm_count,
    trim,
)


class EvidenceError(ValueError):
    """Raised when cached or checkpointed evidence fails verification."""


def _iso_key(iso):
    if "exact" in iso:
        return ["exact", str(Fraction(iso["exact"]))]
    return [str(Fraction(iso["lo"])), str(Fraction(iso["hi"]))]


class EvidenceCache:
    """Verified cache of isolation evidence and rounding results."""

    def __init__(self):
        self._entries = {}   # key -> checkpointable entry dict
        self._results = {}   # key -> {op: int}

    # ------------------------------------------------------------------
    # runtime API (used by AlgebraicNumber)
    # ------------------------------------------------------------------
    def lookup(self, key, op):
        return self._results.get(key, {}).get(op)

    def record(self, alg, op, value):
        key = alg.cache_key()
        entry = self._entries.get(key)
        if entry is None:
            entry = {
                "poly": list(alg.p),
                "iso": alg.iso_json(),
                "refined": None,
                "results": {},
            }
            self._entries[key] = entry
        entry["refined"] = alg.state_json()
        entry["results"][op] = int(value)
        self._results.setdefault(key, {})[op] = int(value)

    # ------------------------------------------------------------------
    # checkpointing
    # ------------------------------------------------------------------
    def to_json(self):
        return {"version": 1, "entries": list(self._entries.values())}

    def save(self, path):
        with open(path, "w") as fh:
            json.dump(self.to_json(), fh, indent=2)

    @classmethod
    def load(cls, path):
        with open(path) as fh:
            return cls.from_json(json.load(fh))

    @classmethod
    def from_json(cls, data):
        if not isinstance(data, dict) or data.get("version") != 1:
            raise EvidenceError("unrecognized checkpoint format")
        entries = data.get("entries")
        if not isinstance(entries, list):
            raise EvidenceError("checkpoint entries must be a list")
        cache = cls()
        for entry in entries:
            cache._load_entry(entry)
        return cache

    # ------------------------------------------------------------------
    # verification
    # ------------------------------------------------------------------
    def _load_entry(self, entry):
        if not isinstance(entry, dict):
            raise EvidenceError("malformed entry")
        try:
            poly = entry["poly"]
            iso = entry["iso"]
            refined = entry.get("refined")
            results = entry.get("results", {})
        except KeyError as e:
            raise EvidenceError(f"malformed entry: missing {e}")
        if not isinstance(poly, list) or not all(
            isinstance(c, int) and not isinstance(c, bool) for c in poly
        ):
            raise EvidenceError("polynomial coefficients must be integers")
        canonical = squarefree_part(poly)
        if canonical != trim(poly):
            raise EvidenceError("polynomial is not in canonical squarefree form")
        if len(canonical) < 2:
            raise EvidenceError("constant polynomial has no root")
        self._verify_state(canonical, iso)
        state = iso
        if refined is not None:
            self._verify_state(canonical, refined, within=iso)
            state = refined
        if not isinstance(results, dict):
            raise EvidenceError("results must be a mapping")
        for op, value in results.items():
            if not isinstance(value, int) or isinstance(value, bool):
                raise EvidenceError("cached result must be an integer")
            self._verify_result(state, op, value)
        key = json.dumps([list(canonical), _iso_key(iso)])
        self._entries[key] = {
            "poly": list(canonical),
            "iso": iso,
            "refined": refined,
            "results": dict(results),
        }
        self._results[key] = dict(results)

    @staticmethod
    def _bounds(state):
        if "exact" in state:
            x = Fraction(state["exact"])
            return x, x
        return Fraction(state["lo"]), Fraction(state["hi"])

    def _verify_state(self, poly, state, within=None):
        if not isinstance(state, dict):
            raise EvidenceError("state must be a mapping")
        try:
            if "exact" in state:
                x = Fraction(state["exact"])
                if sign_at_fraction(poly, x) != 0:
                    raise EvidenceError("claimed exact value is not a root")
            else:
                lo = Fraction(state["lo"])
                hi = Fraction(state["hi"])
                if not lo < hi:
                    raise EvidenceError("interval must satisfy lo < hi")
                if sign_at_fraction(poly, lo) == 0:
                    raise EvidenceError("interval endpoint is a root")
                if sign_at_fraction(poly, hi) == 0:
                    raise EvidenceError("interval endpoint is a root")
                if sturm_count(poly, lo, hi) != 1:
                    raise EvidenceError(
                        "interval does not isolate exactly one real root"
                    )
        except KeyError as e:
            raise EvidenceError(f"malformed state: missing {e}")
        except (ValueError, ZeroDivisionError) as e:
            raise EvidenceError(f"malformed rational in state: {e}")
        if within is not None:
            wlo, whi = self._bounds(within)
            slo, shi = self._bounds(state)
            if not (wlo <= slo and shi <= whi):
                raise EvidenceError("refined interval escapes isolating interval")

    def _verify_result(self, state, op, value):
        v = Fraction(value)
        if "exact" in state:
            x = Fraction(state["exact"])
            expected = {
                "floor": frac_floor,
                "ceil": frac_ceil,
                "round": round_half_even_fraction,
            }.get(op, lambda _x: None)(x)
            if expected is None or expected != value:
                raise EvidenceError(f"cached {op} result is incorrect")
            return
        lo, hi = self._bounds(state)
        half = Fraction(1, 2)
        ok = {
            "floor": lo >= v and hi <= v + 1,
            "ceil": lo >= v - 1 and hi <= v,
            "round": lo >= v - half and hi <= v + half,
        }.get(op)
        if ok is None:
            raise EvidenceError(f"unknown cached operation: {op}")
        if not ok:
            raise EvidenceError(f"cached {op} result inconsistent with interval")
