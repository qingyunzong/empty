"""Core rectangle bin-packing logic.

Coordinate system: bins are axis-aligned rectangles of size (W, H) with the
origin (0, 0) at the bottom-left corner.  Items are placed axis-aligned; an
item may be placed rotated by 90 degrees only when its ``rotate`` flag is
true.  All dimensions and coordinates are integers.
"""

from dataclasses import dataclass
from itertools import combinations_with_replacement

EXACT_MAX_AREA = 64
EXACT_MAX_ITEMS = 10


class InputError(Exception):
    """Raised for invalid user input (maps to CLI exit code 2)."""


@dataclass(frozen=True)
class Item:
    id: object
    w: int
    h: int
    rotate: bool = False


@dataclass(frozen=True)
class BinType:
    id: object
    W: int
    H: int
    count: int = 1


def _require_int(value, what):
    if isinstance(value, bool) or not isinstance(value, int):
        raise InputError(f"{what} must be an integer, got {value!r}")
    return value


def parse_items(raw):
    if not isinstance(raw, list):
        raise InputError("items file must contain a JSON array")
    items = []
    seen = set()
    for i, entry in enumerate(raw):
        if not isinstance(entry, dict):
            raise InputError(f"items[{i}] must be an object")
        try:
            item_id = entry["id"]
            w = _require_int(entry["w"], f"items[{i}].w")
            h = _require_int(entry["h"], f"items[{i}].h")
        except KeyError as exc:
            raise InputError(f"items[{i}] missing field {exc}") from None
        if w <= 0 or h <= 0:
            raise InputError(f"items[{i}] has non-positive dimension {w}x{h}")
        rotate = bool(entry.get("rotate", False))
        if item_id in seen:
            raise InputError(f"duplicate item id {item_id!r}")
        seen.add(item_id)
        items.append(Item(item_id, w, h, rotate))
    return items


def parse_bins(raw):
    if not isinstance(raw, list):
        raise InputError("bins file must contain a JSON array")
    bins = []
    seen = set()
    for i, entry in enumerate(raw):
        if not isinstance(entry, dict):
            raise InputError(f"bins[{i}] must be an object")
        try:
            bin_id = entry["id"]
            W = _require_int(entry["W"], f"bins[{i}].W")
            H = _require_int(entry["H"], f"bins[{i}].H")
        except KeyError as exc:
            raise InputError(f"bins[{i}] missing field {exc}") from None
        count = _require_int(entry.get("count", 1), f"bins[{i}].count")
        if W <= 0 or H <= 0:
            raise InputError(f"bins[{i}] has non-positive dimension {W}x{H}")
        if count < 0:
            raise InputError(f"bins[{i}] has negative count {count}")
        if bin_id in seen:
            raise InputError(f"duplicate bin id {bin_id!r}")
        seen.add(bin_id)
        bins.append(BinType(bin_id, W, H, count))
    return bins


def _fits(placed, x, y, w, h, W, H):
    """True if rect (x, y, w, h) fits in a W x H bin holding `placed` rects."""
    if x + w > W or y + h > H:
        return False
    for px, py, pw, ph in placed:
        if x < px + pw and px < x + w and y < py + ph and py < y + h:
            return False
    return True


def _candidate_positions(placed):
    """Corner points: {0} U {right edges} x {0} U {top edges}, sorted."""
    xs = {0}
    ys = {0}
    for x, y, w, h in placed:
        xs.add(x + w)
        ys.add(y + h)
    return sorted((x, y) for x in xs for y in ys)


def _orientations(item):
    """Yield (w, h, rotated) in the canonical order (unrotated, rotated)."""
    yield item.w, item.h, False
    if item.rotate and (item.h, item.w) != (item.w, item.h):
        yield item.h, item.w, True
    elif item.rotate:
        # w == h: rotated placement is identical; still yield it so the
        # (False, True) orientation order is observable in the output only
        # when it matters.  Skipping keeps results canonical.
        return


def _expand_slots(bins):
    """Expand bin types into ordered copies: (bin_id, copy_index, W, H)."""
    slots = []
    for bt in sorted(bins, key=lambda b: b.id):
        for copy in range(bt.count):
            slots.append((bt.id, copy, bt.W, bt.H))
    return slots


def firstfit(items, bins):
    """First-fit heuristic.

    Items are placed in ascending id order.  For each item, bin copies are
    scanned in (bin id, copy index) order; within a bin, candidate positions
    are scanned in (x, y) lexicographic order and orientations in
    (unrotated, rotated) order.  The first feasible spot wins.

    Returns a placement dict {item_id: (slot_index, x, y, rotated)} together
    with the slot list, or None if some item could not be placed.
    """
    slots = _expand_slots(bins)
    placed = [[] for _ in slots]
    placements = {}
    for item in sorted(items, key=lambda i: i.id):
        spot = None
        for si, (_, _, W, H) in enumerate(slots):
            for x, y in _candidate_positions(placed[si]):
                for w, h, rot in _orientations(item):
                    if _fits(placed[si], x, y, w, h, W, H):
                        spot = (si, x, y, w, h, rot)
                        break
                if spot:
                    break
            if spot:
                break
        if spot is None:
            return None, slots
        si, x, y, w, h, rot = spot
        placed[si].append((x, y, w, h))
        placements[item.id] = (si, x, y, rot)
    return placements, slots


def _search_slots(items, slots):
    """DFS placing items (given in id order) into the given slots.

    Candidates are tried in (slot index, x, y, rotated) lexicographic order,
    so the first solution found is the lexicographically smallest placement
    vector.  Empty identical adjacent slots are pruned (symmetry); this never
    removes the lexicographically first solution.
    """
    placed = [[] for _ in slots]
    solution = {}

    def dfs(i):
        if i == len(items):
            return True
        item = items[i]
        for si, (_, _, W, H) in enumerate(slots):
            if (
                si > 0
                and not placed[si]
                and not placed[si - 1]
                and slots[si][2:] == slots[si - 1][2:]
            ):
                continue
            for x, y in _candidate_positions(placed[si]):
                for w, h, rot in _orientations(item):
                    if _fits(placed[si], x, y, w, h, W, H):
                        placed[si].append((x, y, w, h))
                        solution[item.id] = (si, x, y, rot)
                        if dfs(i + 1):
                            return True
                        placed[si].pop()
                        del solution[item.id]
        return False

    return solution if dfs(0) else None


def exact(items, bins):
    """Exact minimum-bin packing.

    Only attempted when total item area <= EXACT_MAX_AREA and the item count
    is <= EXACT_MAX_ITEMS; otherwise returns ("TOO_LARGE", ...).  Among all
    minimum-bin solutions the one with the lexicographically smallest used
    bin-id sequence wins, ties broken by the lexicographically smallest
    placement vector (items in id order).

    Returns (status, placements, slots) where status is one of
    "OK", "TOO_LARGE", "INFEASIBLE".
    """
    total_area = sum(i.w * i.h for i in items)
    if total_area > EXACT_MAX_AREA or len(items) > EXACT_MAX_ITEMS:
        return "TOO_LARGE", None, None

    ordered = sorted(items, key=lambda i: i.id)
    if not ordered:
        return "OK", {}, []

    types = sorted(bins, key=lambda b: b.id)
    total_copies = sum(t.count for t in types)
    max_k = min(len(ordered), total_copies)

    for k in range(1, max_k + 1):
        for combo in combinations_with_replacement(range(len(types)), k):
            slots = []
            for ti in combo:
                t = types[ti]
                used = sum(1 for s in slots if s[0] == t.id)
                if used >= t.count:
                    slots = None
                    break
                slots.append((t.id, used, t.W, t.H))
            if slots is None:
                continue
            solution = _search_slots(ordered, slots)
            if solution is not None:
                return "OK", solution, slots
    return "INFEASIBLE", None, None


def build_plan(status, placements, slots, items):
    """Build the JSON-serializable plan dict for a successful search."""
    if status != "OK":
        return {"status": status}
    used = sorted({slot for (slot, _, _, _) in placements.values()})
    plan = {
        "status": "OK",
        "used_bins": [
            {"id": slots[s][0], "copy": slots[s][1]} for s in used
        ],
        "placements": [
            {
                "item": item.id,
                "bin": slots[placements[item.id][0]][0],
                "copy": slots[placements[item.id][0]][1],
                "x": placements[item.id][1],
                "y": placements[item.id][2],
                "rotated": placements[item.id][3],
            }
            for item in sorted(items, key=lambda i: i.id)
        ],
    }
    return plan
