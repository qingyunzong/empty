"""Exact set algebras for condition spaces.

A condition denotes a set of inputs (assignments of values to fields).  A
*space* is represented as a list of *cubes*; a cube maps field names to
per-field set representations (fields absent from a cube are unconstrained).
The per-field representations are:

* ``int``    -- tuple of disjoint, sorted, inclusive ``(lo, hi)`` intervals;
                ``None`` denotes an unbounded side.
* ``string`` -- ``(exact, cylinders)``: a frozenset of exact strings plus a
                tuple of pairwise-incompatible prefixes; the meaning is the
                union of the exact strings and all strings carrying one of
                the prefixes.  Complements are taken relative to a finite
                alphabet: every character occurring in any string literal of
                the policy, plus a sentinel for "any other character".  This
                quotient preserves prefix membership exactly, so inclusion
                checks are exact.
* ``enum``   -- a frozenset of values from the declared finite domain.

All representations are closed under union, intersection and complement, so
emptiness and inclusion of arbitrary and/or/not conditions are decidable.
"""

from __future__ import annotations

# --------------------------------------------------------------------------
# integer interval sets
# --------------------------------------------------------------------------

INT_FULL = ((None, None),)
INT_EMPTY = ()


def _lo_key(lo):
    return (0, 0) if lo is None else (1, lo)


def int_normalize(intervals):
    cleaned = [
        (lo, hi) for lo, hi in intervals if lo is None or hi is None or lo <= hi
    ]
    cleaned.sort(key=lambda t: _lo_key(t[0]))
    out = []
    for lo, hi in cleaned:
        if out:
            plo, phi = out[-1]
            # merge when overlapping or adjacent (integer domains)
            if phi is None or lo <= phi + 1:
                out[-1] = (plo, None if hi is None else max(phi, hi))
                continue
        out.append((lo, hi))
    return tuple(out)


def int_interval(lo, hi):
    return ((lo, hi),)


def int_union(a, b):
    return int_normalize(list(a) + list(b))


def int_intersect(a, b):
    out = []
    for lo1, hi1 in a:
        for lo2, hi2 in b:
            lo = lo1 if lo2 is None else lo2 if lo1 is None else max(lo1, lo2)
            hi = hi1 if hi2 is None else hi2 if hi1 is None else min(hi1, hi2)
            if lo is None or hi is None or lo <= hi:
                out.append((lo, hi))
    return int_normalize(out)


def int_complement(a):
    if not a:
        return INT_FULL
    out = []
    if a[0][0] is not None:
        out.append((None, a[0][0] - 1))
    for (_, hi1), (lo2, _) in zip(a, a[1:]):
        out.append((hi1 + 1, lo2 - 1))
    if a[-1][1] is not None:
        out.append((a[-1][1] + 1, None))
    return tuple(out)


def int_is_empty(a):
    return len(a) == 0


def int_subset(a, b):
    return int_is_empty(int_intersect(a, int_complement(b)))


def int_member(value, a):
    return any(
        (lo is None or lo <= value) and (hi is None or value <= hi) for lo, hi in a
    )


# --------------------------------------------------------------------------
# string prefix sets
# --------------------------------------------------------------------------

STR_FULL = (frozenset(), ("",))
STR_EMPTY = (frozenset(), ())


def str_normalize(exact, cylinders):
    kept = []
    for c in sorted(set(cylinders)):
        if not any(c.startswith(k) for k in kept):
            kept.append(c)
    kept = tuple(kept)
    exact = frozenset(s for s in exact if not any(s.startswith(k) for k in kept))
    return (exact, kept)


def str_exact(s):
    return (frozenset({s}), ())


def str_cylinder(prefix):
    return (frozenset(), (prefix,))


def str_union(a, b):
    return str_normalize(a[0] | b[0], a[1] + b[1])


def str_intersect(a, b):
    exact_a, cyl_a = a
    exact_b, cyl_b = b
    exact = set(exact_a & exact_b)
    exact |= {s for s in exact_a if any(s.startswith(p) for p in cyl_b)}
    exact |= {s for s in exact_b if any(s.startswith(p) for p in cyl_a)}
    cyls = []
    for p in cyl_a:
        for q in cyl_b:
            if p.startswith(q):
                cyls.append(p)
            elif q.startswith(p):
                cyls.append(q)
    return str_normalize(exact, cyls)


def _comp_cylinder(prefix, alphabet):
    exact = {prefix[:i] for i in range(len(prefix))}
    cyls = [
        prefix[:i] + d
        for i in range(len(prefix))
        for d in alphabet
        if d != prefix[i]
    ]
    return str_normalize(exact, cyls)


def _comp_exact(s, alphabet):
    exact, cyls = _comp_cylinder(s, alphabet)
    return str_normalize(exact, list(cyls) + [s + d for d in alphabet])


def str_complement(a, alphabet):
    result = STR_FULL
    for s in a[0]:
        result = str_intersect(result, _comp_exact(s, alphabet))
    for c in a[1]:
        result = str_intersect(result, _comp_cylinder(c, alphabet))
    return result


def str_is_empty(a):
    return not a[0] and not a[1]


def str_subset(a, b, alphabet):
    return str_is_empty(str_intersect(a, str_complement(b, alphabet)))


def str_member(value, a):
    return value in a[0] or any(value.startswith(c) for c in a[1])


# --------------------------------------------------------------------------
# cubes and spaces
# --------------------------------------------------------------------------


def rep_is_empty(kind, rep):
    if kind == "int":
        return int_is_empty(rep)
    if kind == "string":
        return str_is_empty(rep)
    return len(rep) == 0  # enum


def rep_intersect(kind, a, b):
    if kind == "int":
        return int_intersect(a, b)
    if kind == "string":
        return str_intersect(a, b)
    return a & b  # enum


def rep_complement(ftype, rep, alphabet):
    if ftype.kind == "int":
        return int_complement(rep)
    if ftype.kind == "string":
        return str_complement(rep, alphabet)
    return frozenset(ftype.domain) - rep  # enum


def rep_full(ftype):
    if ftype.kind == "int":
        return INT_FULL
    if ftype.kind == "string":
        return STR_FULL
    return frozenset(ftype.domain)


def cube_is_empty(cube, schema):
    return any(rep_is_empty(schema[f].kind, rep) for f, rep in cube.items())


def cube_intersect(c1, c2, schema):
    out = dict(c1)
    for f, rep in c2.items():
        if f in out:
            merged = rep_intersect(schema[f].kind, out[f], rep)
            if rep_is_empty(schema[f].kind, merged):
                return None
            out[f] = merged
        else:
            out[f] = rep
    return out


def _cube_key(cube):
    return tuple(sorted((f, repr(rep)) for f, rep in cube.items()))


def _dedup(cubes):
    seen = set()
    out = []
    for cube in cubes:
        key = _cube_key(cube)
        if key not in seen:
            seen.add(key)
            out.append(cube)
    return out


def space_intersect(s1, s2, schema):
    out = []
    for c1 in s1:
        for c2 in s2:
            cube = cube_intersect(c1, c2, schema)
            if cube is not None:
                out.append(cube)
    return _dedup(out)


def cube_complement(cube, schema, alphabet):
    """Complement of a cube: union of single-field complement cubes."""
    out = []
    for f, rep in cube.items():
        comp = rep_complement(schema[f], rep, alphabet)
        if not rep_is_empty(schema[f].kind, comp):
            out.append({f: comp})
    return out


def space_complement(space, schema, alphabet):
    result = [dict()]  # the full space: one unconstrained cube
    for cube in space:
        result = space_intersect(
            result, cube_complement(cube, schema, alphabet), schema
        )
    return result


def space_is_empty(space, schema):
    return all(cube_is_empty(cube, schema) for cube in space)


def space_subset(a, b, schema, alphabet):
    """True iff every input in space ``a`` is also in space ``b``."""
    return space_is_empty(
        space_intersect(a, space_complement(b, schema, alphabet), schema), schema
    )


def space_member(space, schema, inputs):
    """True iff the concrete input assignment matches the space."""
    for cube in space:
        if all(
            rep_member(schema[f].kind, rep, inputs[f]) for f, rep in cube.items()
        ):
            return True
    return False


def rep_member(kind, rep, value):
    if kind == "int":
        return int_member(value, rep)
    if kind == "string":
        return str_member(value, rep)
    return value in rep  # enum
