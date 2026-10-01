"""Core packing logic for the binpack CLI.

Determinism contract
--------------------
* Items are processed in ascending ``id`` order.
* Bin copies are ordered by ``(bin_id, copy_index)``.
* Orientations are tried in ``(False, True)`` order (unrotated first);
  rotation is only attempted when the item has ``rotate=true``.
* Candidate positions are the "corner points" of already-placed
  rectangles: ``x in {0} | {r.x + r.w}``, ``y in {0} | {r.y + r.h}``,
  enumerated in lexicographic ``(x, y)`` order.  The lexicographically
  first feasible integer position is always a corner point (any feasible
  placement can be pushed left/down until it rests against a rectangle
  or the bin edge), so this restriction does not change which point is
  selected, and keeps exact search complete.
* ``exact`` minimises the number of used bins.  Ties are broken by
  1. the lexicographically smallest sorted sequence of used bin ids,
  2. the lexicographically smallest placement list, where placements
     are ordered by item id and each placement compares as
     ``(bin_slot, rotated, x, y)``.
  Because the DFS explores item/bin-slot/orientation/position options
  in exactly that nesting order, the first complete solution found for
  a given bin sequence is the placement-minimal one.
"""

from __future__ import annotations

from dataclasses import dataclass, field

EXACT_MAX_ITEMS = 10
EXACT_MAX_AREA = 64


class InputError(ValueError):
    """Raised for invalid user input (maps to CLI exit code 2)."""


@dataclass(frozen=True)
class Item:
    id: str
    w: int
    h: int
    rotate: bool = False


@dataclass(frozen=True)
class BinType:
    id: str
    W: int
    H: int
    count: int


@dataclass
class PlacedRect:
    item_id: str
    x: int
    y: int
    w: int
    h: int
    rotated: bool


def _require(cond: bool, msg: str) -> None:
    if not cond:
        raise InputError(msg)


def _as_positive_int(value, what: str) -> int:
    _require(isinstance(value, int) and not isinstance(value, bool),
             f"{what} must be an integer, got {value!r}")
    _require(value > 0, f"{what} must be positive, got {value}")
    return value


def parse_items(raw) -> list[Item]:
    _require(isinstance(raw, list), "items must be a JSON array")
    items: list[Item] = []
    seen: set[str] = set()
    for i, entry in enumerate(raw):
        _require(isinstance(entry, dict), f"items[{i}] must be an object")
        try:
            item_id = entry["id"]
            w = entry["w"]
            h = entry["h"]
        except KeyError as exc:
            raise InputError(f"items[{i}] missing field {exc}") from None
        _require(isinstance(item_id, str), f"items[{i}].id must be a string")
        _require(item_id not in seen, f"duplicate item id {item_id!r}")
        seen.add(item_id)
        rotate = entry.get("rotate", False)
        _require(isinstance(rotate, bool),
                 f"items[{i}].rotate must be a boolean")
        items.append(Item(id=item_id,
                          w=_as_positive_int(w, f"items[{i}].w"),
                          h=_as_positive_int(h, f"items[{i}].h"),
                          rotate=rotate))
    return items


def parse_bins(raw) -> list[BinType]:
    _require(isinstance(raw, list), "bins must be a JSON array")
    bins: list[BinType] = []
    seen: set[str] = set()
    for i, entry in enumerate(raw):
        _require(isinstance(entry, dict), f"bins[{i}] must be an object")
        try:
            bin_id = entry["id"]
            W = entry["W"]
            H = entry["H"]
            count = entry["count"]
        except KeyError as exc:
            raise InputError(f"bins[{i}] missing field {exc}") from None
        _require(isinstance(bin_id, str), f"bins[{i}].id must be a string")
        _require(bin_id not in seen, f"duplicate bin id {bin_id!r}")
        seen.add(bin_id)
        _require(isinstance(count, int) and not isinstance(count, bool),
                 f"bins[{i}].count must be an integer")
        _require(count >= 0, f"bins[{i}].count must be >= 0, got {count}")
        bins.append(BinType(id=bin_id,
                            W=_as_positive_int(W, f"bins[{i}].W"),
                            H=_as_positive_int(H, f"bins[{i}].H"),
                            count=count))
    return bins


def _overlaps(a: PlacedRect, x: int, y: int, w: int, h: int) -> bool:
    return not (x + w <= a.x or a.x + a.w <= x or
                y + h <= a.y or a.y + a.h <= y)


def _candidate_positions(placed: list[PlacedRect]) -> list[tuple[int, int]]:
    xs = {0}
    ys = {0}
    for r in placed:
        xs.add(r.x + r.w)
        ys.add(r.y + r.h)
    return sorted((x, y) for x in xs for y in ys)


def _fits(placed: list[PlacedRect], W: int, H: int,
          x: int, y: int, w: int, h: int) -> bool:
    if x + w > W or y + h > H:
        return False
    return not any(_overlaps(r, x, y, w, h) for r in placed)


def _orientations(item: Item) -> list[tuple[int, int, bool]]:
    """(w, h, rotated) in deterministic (False, True) order."""
    dims = [(item.w, item.h, False)]
    if item.rotate and (item.w, item.h) != (item.h, item.w):
        dims.append((item.h, item.w, True))
    elif item.rotate:
        dims.append((item.h, item.w, True))  # square: still try, harmless
    return dims


@dataclass
class BinCopy:
    bin_id: str
    copy: int
    W: int
    H: int
    placed: list[PlacedRect] = field(default_factory=list)


def _expand_copies(bins: list[BinType]) -> list[BinCopy]:
    copies: list[BinCopy] = []
    for b in sorted(bins, key=lambda b: b.id):
        for c in range(b.count):
            copies.append(BinCopy(b.id, c, b.W, b.H))
    return copies


def _result_ok(copies: list[BinCopy]) -> dict:
    used = [c for c in copies if c.placed]
    placements = []
    for c in used:
        for r in c.placed:
            placements.append({
                "item": r.item_id,
                "bin": c.bin_id,
                "copy": c.copy,
                "x": r.x,
                "y": r.y,
                "w": r.w,
                "h": r.h,
                "rotated": r.rotated,
            })
    placements.sort(key=lambda p: p["item"])
    return {
        "status": "OK",
        "used_bins": [{"id": c.bin_id, "copy": c.copy} for c in used],
        "placements": placements,
    }


def pack_firstfit(items: list[Item], bins: list[BinType]) -> dict:
    copies = _expand_copies(bins)
    for item in sorted(items, key=lambda it: it.id):
        placed_ok = False
        for copy in copies:
            for w, h, rotated in _orientations(item):
                if w > copy.W or h > copy.H:
                    continue
                for (x, y) in _candidate_positions(copy.placed):
                    if _fits(copy.placed, copy.W, copy.H, x, y, w, h):
                        copy.placed.append(
                            PlacedRect(item.id, x, y, w, h, rotated))
                        placed_ok = True
                        break
                if placed_ok:
                    break
            if placed_ok:
                break
        if not placed_ok:
            return {"status": "INFEASIBLE"}
    return _result_ok(copies)


def _fits_any_bin(item: Item, bins: list[BinType]) -> bool:
    for b in bins:
        if b.count <= 0:
            continue
        for w, h, _ in _orientations(item):
            if w <= b.W and h <= b.H:
                return True
    return False


def _bin_id_sequences(bin_types: list[BinType], k: int):
    """Yield sorted length-k tuples of bin ids, lexicographic order,
    respecting per-type copy counts (combinations with repetition)."""
    ids = [b.id for b in sorted(bin_types, key=lambda b: b.id) if b.count > 0]
    caps = {b.id: b.count for b in bin_types}

    def rec(start: int, chosen: list[str]):
        if len(chosen) == k:
            yield tuple(chosen)
            return
        for i in range(start, len(ids)):
            bid = ids[i]
            if chosen.count(bid) < caps[bid]:
                chosen.append(bid)
                yield from rec(i, chosen)
                chosen.pop()

    yield from rec(0, [])


def _dfs_pack(items: list[Item], copies: list[BinCopy],
              bin_areas: list[int], idx: int) -> bool:
    if idx == len(items):
        return True
    item = items[idx]
    seen_empty_type: set[str] = set()
    for slot, copy in enumerate(copies):
        if not copy.placed:
            # Symmetry breaking: identical empty copies are interchangeable;
            # only the first empty copy of each bin id is ever tried.
            if copy.bin_id in seen_empty_type:
                continue
            seen_empty_type.add(copy.bin_id)
        for w, h, rotated in _orientations(item):
            if w > copy.W or h > copy.H:
                continue
            for (x, y) in _candidate_positions(copy.placed):
                if _fits(copy.placed, copy.W, copy.H, x, y, w, h):
                    copy.placed.append(
                        PlacedRect(item.id, x, y, w, h, rotated))
                    if _dfs_pack(items, copies, bin_areas, idx + 1):
                        return True
                    copy.placed.pop()
    return False


def pack_exact(items: list[Item], bins: list[BinType]) -> dict:
    total_area = sum(it.w * it.h for it in items)
    if len(items) > EXACT_MAX_ITEMS or total_area > EXACT_MAX_AREA:
        return {"status": "TOO_LARGE"}

    if any(not _fits_any_bin(it, bins) for it in items):
        return {"status": "INFEASIBLE"}
    capacity = sum(b.W * b.H * b.count for b in bins)
    if total_area > capacity:
        return {"status": "INFEASIBLE"}

    ordered_items = sorted(items, key=lambda it: it.id)
    total_copies = sum(b.count for b in bins)
    max_k = min(total_copies, len(items))
    if not items:
        return {"status": "OK", "used_bins": [], "placements": []}

    by_id = {b.id: b for b in bins}
    for k in range(1, max_k + 1):
        for seq in _bin_id_sequences(bins, k):
            if sum(by_id[bid].W * by_id[bid].H for bid in seq) < total_area:
                continue
            counters: dict[str, int] = {}
            copies: list[BinCopy] = []
            for bid in seq:
                b = by_id[bid]
                c = counters.get(bid, 0)
                counters[bid] = c + 1
                copies.append(BinCopy(bid, c, b.W, b.H))
            if _dfs_pack(ordered_items, copies,
                         [c.W * c.H for c in copies], 0):
                return _result_ok(copies)
    return {"status": "INFEASIBLE"}


def pack(items: list[Item], bins: list[BinType], mode: str) -> dict:
    if mode == "exact":
        return pack_exact(items, bins)
    if mode == "firstfit":
        return pack_firstfit(items, bins)
    raise InputError(f"invalid mode {mode!r}; expected 'exact' or 'firstfit'")
