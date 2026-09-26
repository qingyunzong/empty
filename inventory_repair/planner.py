"""迟到负库存修复规划核心逻辑。

模型
----
设按业务序号重排后的事件增量为 d[0..n-1]（入库为正、出库为负），
初始库存为 0。在“第 k 个事件之前”插入一笔补货 r_k（非负整数）后，
第 i 个事件处理完的库存为：

    B(i) = P(i) + sum_{k <= i} r_k,      P(i) = sum_{t=0..i} d[t]

其中 P(i) 是原始前缀和。补货只会叠加到“补货位置及之后”的前缀上。

优化目标（字典序）
------------------
1. 最小化补货总量；
2. 总量相同则最小化补货次数；
3. 再相同则选择最晚的可行补货位置序列（按位置升序后字典序最大）。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterable, Optional


class InvalidEventError(ValueError):
    """事件结构或字段不合法。"""


class DuplicateEventConflict(InvalidEventError):
    """同一事件 ID 再次出现，但业务序号或增量发生了变化。"""


@dataclass(frozen=True)
class Event:
    """一个仓库事件。

    Attributes:
        event_id: 事件唯一标识。
        seq: 业务序号（决定重放顺序）。
        delta: 库存增量；正数入库，负数出库。
    """

    event_id: str
    seq: int
    delta: int

    def to_dict(self) -> dict[str, Any]:
        return {"id": self.event_id, "seq": self.seq, "delta": self.delta}


@dataclass(frozen=True)
class Insertion:
    """一笔补货：在 1-based 槽位 ``slot`` 对应事件之前补 ``amount``。"""

    slot: int
    before_event_id: str
    amount: int

    def to_dict(self) -> dict[str, Any]:
        return {
            "slot": self.slot,
            "before_event_id": self.before_event_id,
            "amount": self.amount,
        }


@dataclass(frozen=True)
class NegativePoint:
    slot: int  # 1-based
    event_id: str
    seq: int
    balance: int  # 无补货时该事件处理完后的库存（负数）

    def to_dict(self) -> dict[str, Any]:
        return {
            "slot": self.slot,
            "event_id": self.event_id,
            "seq": self.seq,
            "balance": self.balance,
        }


def _is_plain_int(value: Any) -> bool:
    """bool 是 int 的子类，业务上必须显式拒绝。"""

    return isinstance(value, int) and not isinstance(value, bool)


class InventoryPlanner:
    """接收（含迟到的）仓库事件，重建库存并给出最优补货方案。"""

    def __init__(self, events: Optional[Iterable[Any]] = None) -> None:
        # event_id -> (seq, delta)
        self._events: dict[str, tuple[int, int]] = {}
        if events is not None:
            for raw in events:
                self.add_event(raw)

    @staticmethod
    def _coerce(raw: Any) -> Event:
        if not isinstance(raw, dict):
            raise InvalidEventError(f"事件必须是对象，实际为 {type(raw).__name__}")
        missing = {"id", "seq", "delta"} - raw.keys()
        if missing:
            raise InvalidEventError(f"事件缺少字段: {sorted(missing)}")
        event_id = raw["id"]
        if not isinstance(event_id, str) or not event_id:
            raise InvalidEventError("事件 id 必须是非空字符串")
        seq = raw["seq"]
        delta = raw["delta"]
        if not _is_plain_int(seq):
            raise InvalidEventError(f"事件 {event_id} 的 seq 必须是整数")
        if not _is_plain_int(delta):
            raise InvalidEventError(f"事件 {event_id} 的 delta 必须是整数")
        return Event(event_id=event_id, seq=seq, delta=delta)

    def add_event(self, raw: Any) -> bool:
        """加入一个事件（含迟到事件）。

        - 相同 ID 且 (seq, delta) 完全一致：视为重复投递，幂等忽略，返回 False。
        - 相同 ID 但 seq 或 delta 变化：拒绝并抛出 :class:`DuplicateEventConflict`。

        Returns:
            True 表示新接收，False 表示幂等去重。
        """

        event = self._coerce(raw)
        existing = self._events.get(event.event_id)
        if existing is not None:
            if existing != (event.seq, event.delta):
                raise DuplicateEventConflict(
                    f"拒绝重复事件 ID {event.event_id!r}: 已有 (seq={existing[0]}, "
                    f"delta={existing[1]})，再次出现为 (seq={event.seq}, "
                    f"delta={event.delta})，内容不允许变化"
                )
            return False
        self._events[event.event_id] = (event.seq, event.delta)
        return True

    def ordered_events(self) -> list[Event]:
        """按业务序号重建顺序；序号相同则以事件 ID 作为确定性次序。"""

        rows = [
            Event(event_id=event_id, seq=seq, delta=delta)
            for event_id, (seq, delta) in self._events.items()
        ]
        return sorted(rows, key=lambda e: (e.seq, e.event_id))

    def analyze(self) -> dict[str, Any]:
        """返回重建结果、最早负库存点与最优补货方案（含最优性证据）。"""

        ordered = self.ordered_events()
        n = len(ordered)

        prefixes: list[int] = []
        running = 0
        for event in ordered:
            running += event.delta
            prefixes.append(running)

        earliest_negative: Optional[NegativePoint] = None
        for i, balance in enumerate(prefixes):
            if balance < 0:
                event = ordered[i]
                earliest_negative = NegativePoint(
                    slot=i + 1,
                    event_id=event.event_id,
                    seq=event.seq,
                    balance=balance,
                )
                break

        # 独立前缀下界：对任意可行补货方案 R，任意前缀 i 必须满足 P(i)+R(i) >= 0，
        # 而 R(i) <= R_total（已插入的补货不会超过总量），故 R_total >= -P(i)。
        # 对所有前缀取最大，再与 0 取大，得到独立下界。
        min_prefix = min(prefixes, default=0)
        lower_bound = max(0, -min_prefix)

        insertions: list[Insertion] = []
        repaired_balances: list[int] = list(prefixes)
        if lower_bound > 0:
            # 下界可一次性达到：在“最早负库存事件”之前补 lower_bound。
            assert earliest_negative is not None
            index = earliest_negative.slot - 1
            target = ordered[index]
            insertions.append(
                Insertion(
                    slot=index + 1,
                    before_event_id=target.event_id,
                    amount=lower_bound,
                )
            )
            repaired_balances = [
                balance + lower_bound for balance in prefixes
            ]

        # 自校验：构造出的方案必须真实可行。
        cumulative = 0
        insertion_by_slot = {item.slot: item.amount for item in insertions}
        for i in range(n):
            cumulative += insertion_by_slot.get(i + 1, 0)
            if prefixes[i] + cumulative < 0:  # pragma: no cover - 构造恒成立
                raise AssertionError("内部错误：构造的补货方案不可行")

        feasible_without = earliest_negative is None
        order_view = [
            {
                "slot": i + 1,
                "id": event.event_id,
                "seq": event.seq,
                "delta": event.delta,
                "balance": prefixes[i],
                "repaired_balance": repaired_balances[i],
            }
            for i, event in enumerate(ordered)
        ]

        evidence = self._build_evidence(lower_bound, earliest_negative, prefixes)

        return {
            "event_count": n,
            "order": order_view,
            "earliest_negative": (
                earliest_negative.to_dict() if earliest_negative else None
            ),
            "lower_bound": lower_bound,
            "feasible_without_replenishment": feasible_without,
            "replenishment": {
                "total": sum(item.amount for item in insertions),
                "count": len(insertions),
                "insertions": [item.to_dict() for item in insertions],
            },
            "evidence": evidence,
        }

    @staticmethod
    def _build_evidence(
        lower_bound: int,
        earliest_negative: Optional[NegativePoint],
        prefixes: list[int],
    ) -> dict[str, str]:
        min_prefix = min(prefixes, default=0)
        if lower_bound == 0:
            independent = (
                "独立前缀下界：min(P(i)) = %d >= 0，所有前缀和均非负，"
                "因此任何可行方案的补货总量下界为 0，且 0 补货本身可行。"
                % min_prefix
            )
            achievability = "构造：无需插入任何补货，逐事件库存均 >= 0，方案可行。"
            min_count = "补货次数：总量为 0 时不能插入正补货，最小次数为 0。"
            latest = "最晚位置：补货次数为 0，位置序列为空，天然唯一。"
            return {
                "independent_prefix_lower_bound": independent,
                "achievability": achievability,
                "minimum_count": min_count,
                "latest_position": latest,
            }

        slot = earliest_negative.slot if earliest_negative else 0
        independent = (
            "独立前缀下界：对任意可行方案，任意前缀 i 需 P(i)+R(i)>=0，"
            "而 R(i)<=补货总量 T，故 T>=max_i(-P(i),0)。"
            "本题 min(P(i))=%d，因此总量下界 T>=%d。"
            % (min_prefix, lower_bound)
        )
        achievability = (
            "可达性：在槽位 %d（最早负库存事件）之前一次性补入 %d。"
            "此前各前缀原本非负；自该槽位起每个前缀都加上 %d，"
            "最小前缀由 %d 变为 %d，全程库存非负，故总量 %d 可达且最优。"
            % (
                slot,
                lower_bound,
                lower_bound,
                min_prefix,
                min_prefix + lower_bound,
                lower_bound,
            )
        )
        min_count = (
            "最小次数：总量下界 %d 为正，0 次补货不可行；上述方案仅用 1 次即达到下界，"
            "因此最小补货次数为 1。" % lower_bound
        )
        latest = (
            "最晚位置：单次补货必须在每个负前缀对应事件之前，故位置不能晚于最早负库存"
            "槽位 %d；放在槽位 %d 仍可行（之后所有前缀同步加 %d 且最小者恰好回到 0），"
            "所以槽位 %d 是唯一的最晚可行位置。"
            % (slot, slot, lower_bound, slot)
        )
        return {
            "independent_prefix_lower_bound": independent,
            "achievability": achievability,
            "minimum_count": min_count,
            "latest_position": latest,
        }


def analyze_events(events: Iterable[Any], late_events: Optional[Iterable[Any]] = None) -> dict[str, Any]:
    """便捷入口：先载入基线事件，再插入迟到事件，然后分析。"""

    planner = InventoryPlanner(events)
    if late_events:
        for raw in late_events:
            planner.add_event(raw)
    return planner.analyze()
