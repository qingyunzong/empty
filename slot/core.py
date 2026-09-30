"""核心调度逻辑。"""

from __future__ import annotations


class BadSlotError(ValueError):
    """非法输入错误, code 固定为 BAD_SLOT。"""

    code = "BAD_SLOT"

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


def _validate_intervals(intervals, what: str) -> None:
    for start, end in intervals:
        if start > end:
            raise BadSlotError(f"{what} interval inverted: [{start}, {end})")


def _merge(intervals):
    """合并 (可重叠的) 半开区间为 canonical 并集。"""
    merged = []
    for start, end in sorted(intervals):
        if start == end:
            continue
        if merged and start <= merged[-1][1]:
            if end > merged[-1][1]:
                merged[-1][1] = end
        else:
            merged.append([start, end])
    return [(lo, hi) for lo, hi in merged]


def _common_free(busy, s, e):
    """所有人忙时并集在 [s, e) 内的补集 (半开)。"""
    all_busy = [iv for person in busy for iv in person]
    _validate_intervals(all_busy, "busy")
    free = []
    cursor = s
    for bs, be in _merge(all_busy):
        if be <= s or bs >= e:
            continue
        lo = max(bs, s)
        hi = min(be, e)
        if lo > cursor:
            free.append((cursor, lo))
        cursor = max(cursor, hi)
    if cursor < e:
        free.append((cursor, e))
    return free


def _overlap_duration(interval, union):
    fs, fe = interval
    total = 0
    for ps, pe in union:
        lo = max(fs, ps)
        hi = min(fe, pe)
        if hi > lo:
            total += hi - lo
    return total


def find_slots(busy, d, s, e, prefer=None):
    """查找最优公共空闲槽。

    参数:
        busy: 每人的忙时列表, 形如 [[(bs, be), ...], ...]。
        d: 所需最小时长, 必须 > 0。
        s, e: 搜索窗 [s, e), 要求 s < e。
        prefer: 可选偏好区间列表, 可重叠, 交集时长只计一次。

    返回:
        {"status": "ok", "score": int, "slots": [(start, end), ...]}
        或 {"status": "none", "slots": []}。

    抛出:
        BadSlotError: d<=0、s>=e 或任意区间倒置 (code=BAD_SLOT)。
    """
    if d <= 0:
        raise BadSlotError(f"duration must be > 0, got {d!r}")
    if s >= e:
        raise BadSlotError(f"search window inverted: [{s}, {e})")

    prefer = prefer or []
    _validate_intervals(prefer, "prefer")
    prefer_union = _merge(prefer)

    feasible = [iv for iv in _common_free(busy, s, e) if iv[1] - iv[0] >= d]
    if not feasible:
        return {"status": "none", "slots": []}

    scored = [(iv, _overlap_duration(iv, prefer_union)) for iv in feasible]
    best = max(score for _, score in scored)
    tied = sorted({iv for iv, score in scored if score == best})
    return {"status": "ok", "score": best, "slots": tied}
