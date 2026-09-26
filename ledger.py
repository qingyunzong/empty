#!/usr/bin/env python3
"""跨批次抵扣有效期账本。

仅使用 Python 3.11 标准库。

语义约定
--------
* 时间用非负整数表示（单位任意，例如“第 N 天”）。
* 批次在 ``expires_at`` 时刻仍可用；严格大于 ``expires_at`` 才到期
  （即到期时刻当天可用，t > expires_at 为过期）。
* 消费按 (expires_at, batch_id) 升序扣减（最早过期优先，过期时间相同
  则批次 ID 较小者优先）。
* 退款必须指定原消费事件 ID，并按该消费当时的实际扣减批次明细退回，
  保证“回到原扣减批次且保留原有效期”。
* 退款 / 撤销发生在批次到期之后：退回数量只计入“过期退回”，不重新
  变成可用积分。
* 重复事件 ID 幂等：同一 event_id 再次出现直接忽略（对账本无影响）。
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass, field
from typing import Iterable


class LedgerError(ValueError):
    """账本输入 / 状态错误。"""


def _is_int(value) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _require_object(event, index: int) -> dict:
    if not isinstance(event, dict):
        raise LedgerError(f"第 {index} 个事件不是 JSON 对象: {event!r}")
    return event


def _require_int(event: dict, key: str, index: int, *, minimum: int = 0) -> int:
    if key not in event:
        raise LedgerError(f"第 {index} 个事件缺少字段 {key!r}: {event}")
    value = event[key]
    if not _is_int(value):
        raise LedgerError(f"第 {index} 个事件字段 {key!r} 必须是整数: {value!r}")
    if value < minimum:
        raise LedgerError(f"第 {index} 个事件字段 {key!r} 不能小于 {minimum}: {value}")
    return value


def _require_str(event: dict, key: str, index: int) -> str:
    if key not in event:
        raise LedgerError(f"第 {index} 个事件缺少字段 {key!r}: {event}")
    value = event[key]
    if not isinstance(value, str) or not value:
        raise LedgerError(f"第 {index} 个事件字段 {key!r} 必须是非空字符串")
    return value


@dataclass
class Batch:
    """一个积分获得批次。

    守恒关系（单批次）：
        earned == available + consumed_open + expired_open
                  + returned_active + returned_expired
    其中过期判定基于“当前账本时间”惰性推进，任何时刻都成立。
    """

    batch_id: str
    earned: int = 0
    available: int = 0
    expires_at: int = 0
    consumed_open: int = 0  # 被消费占用、尚未退款 / 撤销的数量
    expired_open: int = 0  # 到期时仍处于消费占用中的数量
    returned_active: int = 0  # 到期前退回（退款 / 撤销）的数量
    returned_expired: int = 0  # 到期后退回，只记过期退回

    def expire(self, now: int) -> None:
        """把当前时间下应当到期的数量从可用 / 占用转入过期科目。"""
        if now <= self.expires_at:
            return
        self.available = 0
        self.expired_open += self.consumed_open
        self.consumed_open = 0

    def as_dict(self, now: int | None = None) -> dict:
        if now is not None:
            self.expire(now)
        return {
            "batch_id": self.batch_id,
            "expires_at": self.expires_at,
            "earned": self.earned,
            "available": self.available,
            "consumed_open": self.consumed_open,
            "expired_open": self.expired_open,
            "returned_active": self.returned_active,
            "returned_expired": self.returned_expired,
        }


@dataclass
class Consumption:
    """一次消费及其扣减批次明细（退款 / 撤销的唯一依据）。"""

    event_id: str
    time: int
    amount: int
    # [(batch_id, qty), ...] 记录当时实际从哪些批次扣减
    allocations: list[tuple[str, int]]
    refunded: int = 0  # 已按退款处理的数量
    revoked: int = 0  # 已按撤销处理的数量

    @property
    def settled(self) -> int:
        return self.refunded + self.revoked

    @property
    def remaining(self) -> int:
        return self.amount - self.settled
