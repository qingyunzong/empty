# 分摊舍入的可逆账本

订单级折扣按行折前金额比例分摊为整数分，支持分批/部分退货的幂等撤销，并输出守恒证据。
仅依赖 Python 3.11 标准库，无第三方依赖。所有示例均为合成数据。

## 规则

1. **行级分摊**：`share_i = floor(amount_i * D / total)`，剩余尾差按**余数降序**分配，
   余数并列时按**行 ID 字典序升序**优先。保证 `sum(share_i) == D`。
2. **单位级分摊**：行折扣 `d` 分摊到 `qty` 个单位，`base = d // qty`，
   余数 `d % qty` 按**单位序号升序**逐个加 1 分（序号 0 先拿尾差）。
3. **可逆退款**：退款按单位序号升序消费，只撤销被退单位上的**原始分摊**；
   分摊在下单时一次性确定，任何退款都**不会触发对剩余行的重新分摊**。
4. **幂等**：`refund_id` 是幂等键。重复提交返回首次结果（`status: "duplicate"`），
   不变更任何余额，即使 payload 不同。
5. **原子拒绝**：累计退货数量超过该行购买数量（或行不存在、数量非法）时，
   整笔拒绝（`status: "rejected"`），账本状态零变更。

## 运行

```bash
python3 ledger.py --demo          # 内置验收场景（两行各1分，折扣1分）
python3 ledger.py input.json      # 从文件读取
cat input.json | python3 ledger.py  # 从 stdin 读取
python3 -m unittest test_ledger -v  # 运行测试
```

## 输入格式（JSON）

```json
{
  "order": {
    "order_id": "o1",
    "discount": 7,
    "lines": [
      {"line_id": "a", "qty": 3, "unit_price": 10},
      {"line_id": "b", "qty": 2, "unit_price": 5}
    ]
  },
  "refunds": [
    {"refund_id": "r1", "line_id": "a", "qty": 2},
    {"refund_id": "r1", "line_id": "a", "qty": 2}
  ]
}
```

- 金额单位均为**整数分**；`discount` 为订单级总折扣。
- `refunds` 按数组顺序依次处理。

## 输出格式（JSON）

- `allocation.lines[]`：每行 `allocated_discount`、`unit_discounts`（逐单位）、`payable`（实付）。
- `refunds[]`：每笔退款结果。
  - `status`: `applied`（已入账，含 `amount` 退款分、`revoked_discount` 撤销折扣分、`unit_indexes`）；
    `duplicate`（幂等命中，返回首次结果）；`rejected`（含 `reason`：
    `unknown_line` / `invalid_qty` / `exceeds_quantity`）。
- `evidence`：守恒证据。
  - `total_paid` / `total_refunded` / `total_remaining`；
  - `lines[]` 每行 `payable`、`refunded_amount`、`remaining_balance`；
  - `checks`：`discount_fully_allocated`（分摊总额==总折扣）、
    `unit_alloc_matches_line_alloc`（单位分摊和==行分摊）、
    `refund_never_exceeds_paid_per_line`、`total_refund_never_exceeds_total_paid`、
    `balance_conservation`；`all_checks_pass` 为全部通过。

## 验收边界（`--demo` 实测）

两行各 1 分、总折扣 1 分：行 `a` 因字典序优先分得 1 分折扣（实付 0），行 `b` 实付 1。
依次退 `a`（退 0）、退 `b`（退 1）、重复退 `b`（duplicate，余额不变）、再超额退 `b`
（rejected，原子拒绝）。最终 `total_refunded = 1 ≤ total_paid = 1`，与退款顺序无关，
全部守恒检查通过。
