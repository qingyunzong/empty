#!/usr/bin/env python3
"""分摊舍入的可逆账本 (Reversible ledger with apportioned rounding).

规则:
- 订单级折扣按各行折前金额比例分配整数分: 先取地板, 尾差按余数降序、
  余数并列时按行ID字典序分配。
- 行内折扣逐单位分摊, 尾差按单位序号(升序)分配。
- 分批/部分退货只撤销该行原始分摊, 禁止对剩余行重新分摊。
- 重复退款(refund_id 相同)幂等; 超量退款原子拒绝; 输出守恒证据。

仅使用 Python 3.11 标准库。
"""
from __future__ import annotations

import json
import sys
from dataclasses import dataclass


class LedgerError(ValueError):
    """输入不合法。"""


def allocate_discount(amounts: dict[str, int], total_discount: int) -> dict[str, int]:
    """按折前金额比例把 total_discount(整数分) 分配到各行。

    先取地板 floor(amount * D / total), 剩余尾差按余数降序分配,
    余数并列时按行ID字典序升序优先。
    """
    if total_discount < 0:
        raise LedgerError("discount must be >= 0")
    total = sum(amounts.values())
    if total_discount > total:
        raise LedgerError("discount exceeds total pre-discount amount")
    if total == 0:
        if total_discount != 0:
            raise LedgerError("cannot allocate discount on zero-amount order")
        return {lid: 0 for lid in amounts}

    shares: dict[str, int] = {}
    remainders: dict[str, int] = {}
    for lid, amt in amounts.items():
        num = amt * total_discount
        shares[lid], remainders[lid] = divmod(num, total)
    leftover = total_discount - sum(shares.values())
    # 余数降序, 并列按行ID字典序升序
    for lid in sorted(amounts, key=lambda l: (-remainders[l], l))[:leftover]:
        shares[lid] += 1
    return shares


def unit_discounts(line_discount: int, qty: int) -> list[int]:
    """行折扣逐单位分摊: 基础值 floor(d/qty), 尾差按单位序号升序各加 1 分。"""
    base, extra = divmod(line_discount, qty)
    return [base + (1 if i < extra else 0) for i in range(qty)]


@dataclass(frozen=True)
class Line:
    line_id: str
    qty: int
    unit_price: int  # 折前单价, 整数分

    @property
    def amount(self) -> int:
        return self.qty * self.unit_price


class Ledger:
    """可逆账本: 分摊在下单时一次性确定, 退款只撤销原始分摊, 永不重新分摊。"""

    def __init__(self, order_id: str, lines: list[Line], discount: int):
        if not lines:
            raise LedgerError("order must have at least one line")
        ids = [l.line_id for l in lines]
        if len(set(ids)) != len(ids):
            raise LedgerError("duplicate line_id")
        for l in lines:
            if l.qty < 1:
                raise LedgerError(f"line {l.line_id}: qty must be >= 1")
            if l.unit_price < 0:
                raise LedgerError(f"line {l.line_id}: unit_price must be >= 0")
        self.order_id = order_id
        self.lines = list(lines)
        self.discount = discount
        amounts = {l.line_id: l.amount for l in lines}
        # 下单时一次性分摊, 之后绝不因退款重新计算
        self.line_discount = allocate_discount(amounts, discount)
        self.unit_alloc = {
            l.line_id: unit_discounts(self.line_discount[l.line_id], l.qty)
            for l in lines
        }
        self._refunded_qty = {l.line_id: 0 for l in lines}
        self._refunds: dict[str, dict] = {}  # refund_id -> 已应用的退款记录

    def _line(self, line_id: str) -> Line:
        for l in self.lines:
            if l.line_id == line_id:
                return l
        raise KeyError(line_id)

    def refund(self, refund_id: str, line_id: str, qty: int) -> dict:
        """处理一笔退款。幂等 + 原子: 任何拒绝路径都不改变账本状态。"""
        # 幂等: 相同 refund_id 直接返回首次结果, 不变更余额
        if refund_id in self._refunds:
            first = self._refunds[refund_id]
            return {
                "refund_id": refund_id,
                "line_id": first["line_id"],
                "qty": first["qty"],
                "status": "duplicate",
                "amount": first["amount"],
                "revoked_discount": first["revoked_discount"],
            }
        # 以下校验全部通过前不修改任何状态 => 原子拒绝
        try:
            line = self._line(line_id)
        except KeyError:
            return {"refund_id": refund_id, "line_id": line_id, "qty": qty,
                    "status": "rejected", "reason": "unknown_line", "amount": 0}
        if not isinstance(qty, int) or qty < 1:
            return {"refund_id": refund_id, "line_id": line_id, "qty": qty,
                    "status": "rejected", "reason": "invalid_qty", "amount": 0}
        already = self._refunded_qty[line_id]
        if already + qty > line.qty:
            return {"refund_id": refund_id, "line_id": line_id, "qty": qty,
                    "status": "rejected", "reason": "exceeds_quantity",
                    "amount": 0,
                    "refunded_so_far": already, "line_qty": line.qty}

        # 退款按单位序号升序消费, 只撤销这些单位上的原始分摊
        units = self.unit_alloc[line_id]
        revoked = sum(units[already:already + qty])
        amount = qty * line.unit_price - revoked

        self._refunded_qty[line_id] = already + qty
        record = {
            "refund_id": refund_id,
            "line_id": line_id,
            "qty": qty,
            "status": "applied",
            "amount": amount,
            "revoked_discount": revoked,
            "unit_indexes": list(range(already, already + qty)),
        }
        self._refunds[refund_id] = record
        return dict(record)

    def evidence(self) -> dict:
        """守恒证据: 折扣分摊守恒 + 退款不超实付 + 余额守恒。"""
        per_line = []
        total_paid = 0
        total_refunded = 0
        for l in self.lines:
            lid = l.line_id
            alloc = self.line_discount[lid]
            units = self.unit_alloc[lid]
            refunded = self._refunded_qty[lid]
            paid = l.amount - alloc
            refunded_amt = sum(l.unit_price - u for u in units[:refunded])
            per_line.append({
                "line_id": lid,
                "pre_discount_amount": l.amount,
                "allocated_discount": alloc,
                "unit_discounts": units,
                "payable": paid,
                "refunded_qty": refunded,
                "refunded_amount": refunded_amt,
                "remaining_balance": paid - refunded_amt,
            })
            total_paid += paid
            total_refunded += refunded_amt
        checks = {
            "discount_fully_allocated":
                sum(self.line_discount.values()) == self.discount,
            "unit_alloc_matches_line_alloc": all(
                sum(self.unit_alloc[l.line_id]) == self.line_discount[l.line_id]
                for l in self.lines
            ),
            "refund_never_exceeds_paid_per_line": all(
                p["refunded_amount"] <= p["payable"] for p in per_line
            ),
            "total_refund_never_exceeds_total_paid": total_refunded <= total_paid,
            "balance_conservation": all(
                p["remaining_balance"] == p["payable"] - p["refunded_amount"]
                for p in per_line
            ),
        }
        return {
            "order_id": self.order_id,
            "total_discount": self.discount,
            "total_paid": total_paid,
            "total_refunded": total_refunded,
            "total_remaining": total_paid - total_refunded,
            "lines": per_line,
            "checks": checks,
            "all_checks_pass": all(checks.values()),
        }


def build_ledger(spec: dict) -> Ledger:
    lines = [Line(line_id=str(l["line_id"]), qty=int(l["qty"]),
                  unit_price=int(l["unit_price"])) for l in spec["lines"]]
    return Ledger(order_id=str(spec.get("order_id", "order")),
                  lines=lines, discount=int(spec["discount"]))


def run(spec: dict) -> dict:
    ledger = build_ledger(spec["order"])
    refund_results = [
        ledger.refund(refund_id=str(r["refund_id"]), line_id=str(r["line_id"]),
                      qty=int(r["qty"]))
        for r in spec.get("refunds", [])
    ]
    return {
        "order_id": ledger.order_id,
        "allocation": {
            "total_discount": ledger.discount,
            "lines": [
                {
                    "line_id": l.line_id,
                    "pre_discount_amount": l.amount,
                    "allocated_discount": ledger.line_discount[l.line_id],
                    "unit_discounts": ledger.unit_alloc[l.line_id],
                    "payable": l.amount - ledger.line_discount[l.line_id],
                }
                for l in ledger.lines
            ],
        },
        "refunds": refund_results,
        "evidence": ledger.evidence(),
    }


DEMO_SPEC = {
    "order": {
        "order_id": "demo-acceptance",
        "lines": [
            {"line_id": "a", "qty": 1, "unit_price": 1},
            {"line_id": "b", "qty": 1, "unit_price": 1},
        ],
        "discount": 1,
    },
    "refunds": [
        {"refund_id": "r1", "line_id": "a", "qty": 1},
        {"refund_id": "r2", "line_id": "b", "qty": 1},
        {"refund_id": "r2", "line_id": "b", "qty": 1},
        {"refund_id": "r3", "line_id": "b", "qty": 1},
    ],
}


def main(argv: list[str]) -> int:
    if "--demo" in argv:
        spec = DEMO_SPEC
    else:
        args = [a for a in argv[1:] if not a.startswith("--")]
        if args:
            with open(args[0], "r", encoding="utf-8") as f:
                spec = json.load(f)
        else:
            spec = json.load(sys.stdin)
    try:
        result = run(spec)
    except (LedgerError, KeyError, TypeError, ValueError) as e:
        print(json.dumps({"error": str(e)}, ensure_ascii=False), file=sys.stderr)
        return 2
    json.dump(result, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
