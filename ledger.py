"""分摊舍入的可逆账本（Python 3.11 标准库，无第三方依赖）。

核心规则：
- 订单级折扣按各行折前金额比例分配整数分：先取地板，
  尾差按"小数余数降序、行ID字典序升序"逐分分配。
- 行内折扣逐单位分摊：尾差按单位序号（从 0 起）优先分配。
- 分批退款只撤销该行原始分摊，绝不对剩余行重新分摊。
- 退款幂等（按 refund_id），超量退款原子拒绝，输出守恒证据。
"""

from __future__ import annotations

import json
import sys
from dataclasses import dataclass, field


class LedgerError(Exception):
    """账本领域错误（校验失败、超量退款等）。"""


def allocate_discount(amounts: dict[str, int], total_discount: int) -> dict[str, int]:
    """把整数分折扣按比例分摊到各行。

    先取地板 floor(amount_i * D / total)，剩余尾差按
    (小数余数降序, 行ID字典序升序) 逐分分配。
    """
    if total_discount < 0:
        raise LedgerError("discount must be >= 0")
    total = sum(amounts.values())
    if total_discount > total:
        raise LedgerError("discount exceeds total pre-discount amount")
    if total == 0:
        if total_discount:
            raise LedgerError("cannot discount a zero-amount order")
        return {lid: 0 for lid in amounts}

    shares: dict[str, int] = {}
    ranked: list[tuple[int, str]] = []  # (-余数, 行ID)：排序即余数降序、ID升序
    for lid, amt in amounts.items():
        quotient, rem = divmod(amt * total_discount, total)
        shares[lid] = quotient
        ranked.append((-rem, lid))

    leftover = total_discount - sum(shares.values())
    # leftover < 行数，因为各行小数余数之和 < 行数
    for _, lid in sorted(ranked)[:leftover]:
        shares[lid] += 1
    return shares


@dataclass
class Line:
    line_id: str
    unit_price: int  # 折前单价（整数分）
    quantity: int
    discount: int  # 该行分摊到的总折扣（整数分，创建后不再变化）
    refunded_count: int = 0  # 已退单位数（总是退序号最小的未退单位）

    @property
    def amount(self) -> int:
        return self.unit_price * self.quantity

    @property
    def paid(self) -> int:
        """该行实付（折后）金额。"""
        return self.amount - self.discount

    def unit_discount(self, ordinal: int) -> int:
        """第 ordinal 个单位（0 起）分摊到的折扣：尾差按单位序号优先。"""
        base, rem = divmod(self.discount, self.quantity)
        return base + (1 if ordinal < rem else 0)

    def unit_net(self, ordinal: int) -> int:
        """第 ordinal 个单位的实付金额（退款即退该金额）。"""
        return self.unit_price - self.unit_discount(ordinal)

    @property
    def remaining_count(self) -> int:
        return self.quantity - self.refunded_count

    @property
    def refunded_amount(self) -> int:
        return sum(self.unit_net(k) for k in range(self.refunded_count))

    @property
    def remaining_amount(self) -> int:
        return self.paid - self.refunded_amount


@dataclass
class Order:
    order_id: str
    lines: dict[str, Line] = field(default_factory=dict)

    @property
    def total_amount(self) -> int:
        return sum(ln.amount for ln in self.lines.values())

    @property
    def total_discount(self) -> int:
        return sum(ln.discount for ln in self.lines.values())

    @property
    def total_paid(self) -> int:
        return sum(ln.paid for ln in self.lines.values())

    @property
    def total_refunded(self) -> int:
        return sum(ln.refunded_amount for ln in self.lines.values())

    @property
    def total_remaining(self) -> int:
        return sum(ln.remaining_amount for ln in self.lines.values())

    def evidence(self) -> dict:
        """守恒证据：实付 = 已退 + 剩余，且已退永不超过实付。"""
        per_line = {
            lid: {
                "paid": ln.paid,
                "refunded": ln.refunded_amount,
                "remaining": ln.remaining_amount,
                "conserved": ln.paid == ln.refunded_amount + ln.remaining_amount,
            }
            for lid, ln in sorted(self.lines.items())
        }
        return {
            "order_id": self.order_id,
            "total_amount": self.total_amount,
            "total_discount": self.total_discount,
            "total_paid": self.total_paid,
            "total_refunded": self.total_refunded,
            "total_remaining": self.total_remaining,
            "lines": per_line,
            "checks": {
                "line_conservation": all(v["conserved"] for v in per_line.values()),
                "order_conservation": self.total_paid
                == self.total_refunded + self.total_remaining,
                "no_over_refund": self.total_refunded <= self.total_paid,
            },
        }


class Ledger:
    """可逆账本：订单创建 + 幂等退款。"""

    def __init__(self) -> None:
        self.orders: dict[str, Order] = {}
        self.refunds: dict[str, dict] = {}  # refund_id -> 退款结果记录（幂等依据）

    def create_order(self, order_id: str, lines: list[dict], discount: int) -> dict:
        if order_id in self.orders:
            raise LedgerError(f"duplicate order_id: {order_id}")
        if not lines:
            raise LedgerError("order must have at least one line")
        seen: set[str] = set()
        amounts: dict[str, int] = {}
        for spec in lines:
            lid = spec["line_id"]
            price = int(spec["unit_price"])
            qty = int(spec["quantity"])
            if lid in seen:
                raise LedgerError(f"duplicate line_id: {lid}")
            if price < 0 or qty < 1:
                raise LedgerError(f"invalid line {lid}: price>=0, quantity>=1 required")
            seen.add(lid)
            amounts[lid] = price * qty

        shares = allocate_discount(amounts, int(discount))
        order = Order(order_id=order_id)
        for spec in lines:
            lid = spec["line_id"]
            order.lines[lid] = Line(
                line_id=lid,
                unit_price=int(spec["unit_price"]),
                quantity=int(spec["quantity"]),
                discount=shares[lid],
            )
        self.orders[order_id] = order
        return {
            "status": "ok",
            "order_id": order_id,
            "allocation": {lid: order.lines[lid].discount for lid in sorted(order.lines)},
            "evidence": order.evidence(),
        }

    def refund(self, refund_id: str, order_id: str, line_id: str, quantity: int) -> dict:
        """退款。同一 refund_id 幂等；超量原子拒绝（不产生任何状态变更）。"""
        if refund_id in self.refunds:
            record = dict(self.refunds[refund_id])
            record["idempotent_replay"] = True
            return record

        order = self.orders.get(order_id)
        if order is None:
            raise LedgerError(f"unknown order_id: {order_id}")
        line = order.lines.get(line_id)
        if line is None:
            raise LedgerError(f"unknown line_id: {line_id}")
        quantity = int(quantity)
        if quantity < 1:
            raise LedgerError("refund quantity must be >= 1")
        if quantity > line.remaining_count:
            # 原子拒绝：不修改任何状态，仅记录该 refund_id 的拒绝结果
            record = {
                "status": "rejected",
                "reason": "over_quantity",
                "refund_id": refund_id,
                "order_id": order_id,
                "line_id": line_id,
                "requested": quantity,
                "remaining": line.remaining_count,
                "idempotent_replay": False,
                "evidence": order.evidence(),
            }
            self.refunds[refund_id] = record
            return dict(record)

        # 只撤销该行原始分摊：退序号最小的未退单位，逐单位实付求和
        units = []
        amount = 0
        for k in range(line.refunded_count, line.refunded_count + quantity):
            net = line.unit_net(k)
            units.append({"ordinal": k, "net": net})
            amount += net
        line.refunded_count += quantity  # 唯一的原地状态变更

        record = {
            "status": "ok",
            "refund_id": refund_id,
            "order_id": order_id,
            "line_id": line_id,
            "quantity": quantity,
            "amount": amount,
            "units": units,
            "idempotent_replay": False,
            "evidence": order.evidence(),
        }
        self.refunds[refund_id] = record
        return dict(record)

    def snapshot(self, order_id: str) -> dict:
        order = self.orders.get(order_id)
        if order is None:
            raise LedgerError(f"unknown order_id: {order_id}")
        return {"status": "ok", "evidence": order.evidence()}


def run_commands(ledger: Ledger, commands: list[dict]) -> list[dict]:
    results = []
    for cmd in commands:
        op = cmd.get("op")
        try:
            if op == "create_order":
                results.append(
                    ledger.create_order(cmd["order_id"], cmd["lines"], cmd["discount"])
                )
            elif op == "refund":
                results.append(
                    ledger.refund(
                        cmd["refund_id"], cmd["order_id"], cmd["line_id"], cmd["quantity"]
                    )
                )
            elif op == "snapshot":
                results.append(ledger.snapshot(cmd["order_id"]))
            else:
                raise LedgerError(f"unknown op: {op!r}")
        except (LedgerError, KeyError, TypeError, ValueError) as exc:
            results.append({"status": "error", "op": op, "reason": str(exc)})
    return results


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if len(argv) > 1:
        print("usage: python3 ledger.py [commands.json]  (缺省从 stdin 读取)", file=sys.stderr)
        return 2
    if argv:
        with open(argv[0], "r", encoding="utf-8") as fh:
            payload = json.load(fh)
    else:
        payload = json.load(sys.stdin)
    commands = payload["commands"] if isinstance(payload, dict) else payload
    results = run_commands(Ledger(), commands)
    json.dump({"results": results}, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
