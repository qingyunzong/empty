"""跨批次抵扣有效期账本（纯标准库）。

积分按“批次”获得，每个批次有数量与过期时间。消费按最早过期时间
（FEFO, First Expire First Out）扣减，过期时间相同则按批次 ID 升序。
退款严格回到原扣减批次，并保留该批次的原有效期：
  - 退款时点原批次尚未到期 -> 重新进入该批次可用；
  - 退款时点原批次已经到期 -> 只记“过期退回”，不会重新变成可用积分。
重复撤销（refund）幂等，超退/未知引用报错。

时间采用整数时间轴：批次在 time == expiry 时到期，即有效区间为
[earn_time, expiry)，左闭右开。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

__all__ = ["Ledger", "LedgerError", "Allocation"]


class LedgerError(Exception):
    """事件不合法（余额不足、未知引用、超退、字段非法等）。"""


@dataclass
class Allocation:
    """一次消费对某一个批次的扣减明细，退款沿此结构原路返回。"""

    batch_id: str
    amount: int
    expiry: int
    refunded: int = 0

    def remaining_refund(self) -> int:
        return self.amount - self.refunded


@dataclass
class _Batch:
    batch_id: str
    amount: int
    expiry: int
    available: int
    consumed: int = 0
    available_refunded: int = 0
    expired_from_available: int = 0
    expired_from_consumption: int = 0
    expired_swept: bool = False

    @property
    def total_refunded(self) -> int:
        return self.available_refunded + self.expired_from_consumption


@dataclass
class _Consumption:
    consumption_id: str
    time: int
    allocations: list[Allocation]


class Ledger:
    def __init__(self) -> None:
        self._batches: dict[str, _Batch] = {}
        self._consumptions: dict[str, _Consumption] = {}
        self._refund_ids: set[str] = set()
        self.warnings: list[str] = []

    # ---------- 内部工具 ----------

    def _get_batch(self, batch_id: str) -> _Batch:
        batch = self._batches.get(batch_id)
        if batch is None:
            raise LedgerError(f"批次不存在: {batch_id!r}")
        return batch

    @staticmethod
    def _as_positive_int(value, field_name: str) -> int:
        if isinstance(value, bool) or not isinstance(value, int):
            raise LedgerError(f"{field_name} 必须为正整数，收到: {value!r}")
        if value <= 0:
            raise LedgerError(f"{field_name} 必须为正整数，收到: {value!r}")
        return value

    def _sweep_batch(self, batch: _Batch, now: int) -> None:
        """把批次在 now 时点仍未使用的可用分转为过期，幂等。"""
        if not batch.expired_swept and now >= batch.expiry:
            batch.expired_from_available += batch.available
            batch.available = 0
            batch.expired_swept = True

    # ---------- 事件 ----------

    def earn(self, batch_id: str, amount: int, expiry: int,
             time: Optional[int] = None) -> None:
        """获得一个积分批次。"""
        if not isinstance(batch_id, str) or not batch_id:
            raise LedgerError(f"批次 ID 必须为非空字符串，收到: {batch_id!r}")
        amount = self._as_positive_int(amount, "amount")
        expiry = self._as_positive_int(expiry, "expiry")
        if time is None:
            time = 0
        elif not isinstance(time, int) or isinstance(time, bool):
            raise LedgerError(f"time 必须为整数，收到: {time!r}")
        if batch_id in self._batches:
            raise LedgerError(f"批次 ID 重复: {batch_id!r}")
        if time >= expiry:
            self.warnings.append(
                f"批次 {batch_id!r} 获得时已到期（time={time} >= expiry={expiry}），"
                f"积分直接计入过期"
            )
            self._batches[batch_id] = _Batch(
                batch_id=batch_id, amount=amount, expiry=expiry, available=0,
                expired_from_available=amount, expired_swept=True,
            )
            return
        self._batches[batch_id] = _Batch(
            batch_id=batch_id, amount=amount, expiry=expiry, available=amount,
        )

    def consume(self, consumption_id: str, amount: int,
                time: int) -> list[Allocation]:
        """按 FEFO（过期时间升序、再批次 ID 升序）扣减。

        余额不足时整笔拒绝（不做部分扣减）。
        """
        if not isinstance(consumption_id, str) or not consumption_id:
            raise LedgerError(
                f"消费 ID 必须为非空字符串，收到: {consumption_id!r}")
        if consumption_id in self._consumptions:
            raise LedgerError(f"消费 ID 重复: {consumption_id!r}")
        amount = self._as_positive_int(amount, "amount")
        if not isinstance(time, int) or isinstance(time, bool):
            raise LedgerError(f"time 必须为整数，收到: {time!r}")

        for batch in list(self._batches.values()):
            self._sweep_batch(batch, time)

        candidates = sorted(
            self._batches.values(),
            key=lambda b: (b.expiry, b.batch_id),
        )
        usable = sum(b.available for b in candidates if b.expiry > time)
        if usable < amount:
            raise LedgerError(
                f"消费 {consumption_id!r} 余额不足: 需要 {amount}，可用 {usable}"
            )

        allocations: list[Allocation] = []
        remaining = amount
        for batch in candidates:
            if remaining == 0:
                break
            if batch.available <= 0 or batch.expiry <= time:
                continue
            take = min(batch.available, remaining)
            batch.available -= take
            batch.consumed += take
            remaining -= take
            allocations.append(
                Allocation(batch_id=batch.batch_id, amount=take,
                           expiry=batch.expiry)
            )
        self._consumptions[consumption_id] = _Consumption(
            consumption_id=consumption_id, time=time,
            allocations=allocations,
        )
        return allocations

    def refund(self, consumption_id: str, amount: int, time: int,
               refund_id: Optional[str] = None) -> dict[str, int]:
        """退款：沿原扣减明细返回原批次并保留原有效期。

        refund_id 用于撤销幂等：同一 refund_id 重复出现时只返回首次结果，
        不重复退回。返回 {"valid": 重新可用的数量, "expired": 过期退回数量}。
        """
        if not isinstance(time, int) or isinstance(time, bool):
            raise LedgerError(f"time 必须为整数，收到: {time!r}")
        amount = self._as_positive_int(amount, "amount")
        if refund_id is None:
            refund_id = f"{consumption_id}:{amount}"
        if not isinstance(refund_id, str) or not refund_id:
            raise LedgerError(
                f"退款 ID 必须为非空字符串，收到: {refund_id!r}")
        if refund_id in self._refund_ids:
            self.warnings.append(f"退款 {refund_id!r} 重复提交，已幂等忽略")
            return {"valid": 0, "expired": 0}

        consumption = self._consumptions.get(consumption_id)
        if consumption is None:
            raise LedgerError(f"消费 ID 不存在: {consumption_id!r}")
        refundable = sum(a.remaining_refund() for a in consumption.allocations)
        if amount > refundable:
            raise LedgerError(
                f"退款 {refund_id!r} 超退: 申请 {amount}，可退 {refundable}"
            )

        for batch in self._batches.values():
            self._sweep_batch(batch, time)

        # 退款沿用扣减时的 FEFO 顺序（最早过期、再批次 ID），逐笔原路返回。
        allocations = sorted(
            consumption.allocations,
            key=lambda a: (a.expiry, a.batch_id),
        )
        valid_total = 0
        expired_total = 0
        remaining = amount
        for allocation in allocations:
            if remaining == 0:
                break
            batch = self._get_batch(allocation.batch_id)
            cap = allocation.remaining_refund()
            take = min(cap, remaining)
            if take == 0:
                continue
            allocation.refunded += take
            batch.consumed -= take
            if time < allocation.expiry:
                # 原批次仍有效：回到该批次可用，有效期不变。
                batch.available += take
                batch.available_refunded += take
                valid_total += take
            else:
                # 原批次已到期：只记过期退回，不重新可用。
                batch.expired_from_consumption += take
                expired_total += take
            remaining -= take

        self._refund_ids.add(refund_id)
        return {"valid": valid_total, "expired": expired_total}

    # ---------- 查询 ----------

    def report(self, now: Optional[int] = None) -> dict:
        if now is None:
            times = [b.expiry for b in self._batches.values()]
            times += [c.time for c in self._consumptions.values()]
            now = max(times, default=0)
        if not isinstance(now, int) or isinstance(now, bool):
            raise LedgerError(f"now 必须为整数，收到: {now!r}")

        for batch in self._batches.values():
            self._sweep_batch(batch, now)

        batches = []
        total_available = 0
        total_consumed = 0
        total_expired = 0
        total_refunded = 0
        total_earned = 0
        for batch_id in sorted(self._batches):
            batch = self._batches[batch_id]
            available = batch.available if now < batch.expiry else 0
            expired = (batch.expired_from_available
                       + batch.expired_from_consumption)
            total_earned += batch.amount
            total_available += available
            total_consumed += batch.consumed
            total_expired += expired
            total_refunded += batch.total_refunded
            batches.append({
                "batch_id": batch.batch_id,
                "amount": batch.amount,
                "expiry": batch.expiry,
                "available": available,
                "consumed": batch.consumed,
                "refunded_valid": batch.available_refunded,
                "refunded_expired": batch.expired_from_consumption,
                "refunded_total": batch.total_refunded,
                "expired": expired,
            })

        conservation_ok = (
            total_available + total_consumed + total_expired == total_earned
            and total_refunded <= total_earned
        )
        return {
            "time": now,
            "totals": {
                "earned": total_earned,
                "available": total_available,
                "consumed": total_consumed,
                "expired": total_expired,
                "refunded_total": total_refunded,
                "refunded_valid": sum(b["refunded_valid"] for b in batches),
                "refunded_expired": sum(
                    b["refunded_expired"] for b in batches),
            },
            "conservation": {
                "available_plus_consumed_plus_expired_equals_earned":
                    total_available + total_consumed + total_expired
                    == total_earned,
                "ok": conservation_ok,
            },
            "batches": batches,
            "warnings": list(self.warnings),
        }

    def apply_event(self, event: dict) -> dict:
        """应用一条字典事件，返回该事件的结果信息。"""
        if not isinstance(event, dict):
            raise LedgerError(f"事件必须为对象: {event!r}")
        op = event.get("op") or event.get("type")
        if op in ("earn", "获得"):
            self.earn(
                batch_id=str(event["batch_id"]),
                amount=event["amount"],
                expiry=event["expiry"],
                time=event.get("time", 0),
            )
            return {"op": "earn"}
        if op in ("consume", "消费"):
            allocations = self.consume(
                consumption_id=str(event["consumption_id"]),
                amount=event["amount"],
                time=event["time"],
            )
            return {
                "op": "consume",
                "allocations": [
                    {"batch_id": a.batch_id, "amount": a.amount,
                     "expiry": a.expiry}
                    for a in allocations
                ],
            }
        if op in ("refund", "退款", "撤销"):
            result = self.refund(
                consumption_id=str(event["consumption_id"]),
                amount=event["amount"],
                time=event["time"],
                refund_id=event.get("refund_id"),
            )
            return {"op": "refund", **result}
        raise LedgerError(f"未知事件类型: {op!r}")
