# 分摊舍入的可逆账本

纯 Python 3.11 标准库实现（无第三方依赖）。订单级折扣按行比例分摊为整数分，
分批退款只撤销该行原始分摊、绝不重新分摊，退款幂等且超量原子拒绝，全程输出守恒证据。
所有示例均为合成数据。

## 运行

```bash
python3 ledger.py [commands.json]   # 缺省从 stdin 读取，结果输出到 stdout
python3 -m unittest -v              # 运行测试
```

## 分摊规则

1. 行级分摊：每行应得 `floor(行折前金额 × 总折扣 / 订单折前总额)`；
   剩余尾差按 **(小数余数降序, 行ID字典序升序)** 逐分分配，保证 `Σ行分摊 = 总折扣`。
2. 单位分摊：行内每单位折扣 `base = 行折扣 // 数量`，余数按 **单位序号（0 起）优先**，
   即序号 `< 行折扣 % 数量` 的单位多承担 1 分。
3. 退款：只撤销该行原始分摊（退序号最小的未退单位，逐单位实付求和），
   其他行的分摊与余额不变。`refund_id` 为幂等键；超量退款原子拒绝、无状态变更。
4. 守恒证据：每笔操作返回 `evidence`，断言
   `实付 = 已退 + 剩余`（行级与订单级）且 `总已退 ≤ 总实付`。

## 输入格式

JSON 数组（或 `{"commands": [...]}`），元素为命令对象：

| op | 字段 | 说明 |
|---|---|---|
| `create_order` | `order_id`, `lines[{line_id, unit_price, quantity}]`, `discount` | 建单并分摊折扣（整数分） |
| `refund` | `refund_id`, `order_id`, `line_id`, `quantity` | 幂等退款；超量原子拒绝 |
| `snapshot` | `order_id` | 查询当前守恒证据 |

## 输出格式

`{"results": [...]}`，每条命令对应一个结果：

- `create_order`：`{status, order_id, allocation{行ID: 分摊折扣}, evidence}`
- `refund` 成功：`{status:"ok", refund_id, amount, units[{ordinal, net}], idempotent_replay, evidence}`
- `refund` 拒绝：`{status:"rejected", reason:"over_quantity", requested, remaining, ...}`
- 重复 `refund_id`：返回首次记录且 `idempotent_replay: true`，余额不变
- 参数/领域错误：`{status:"error", op, reason}`

## 示例（验收边界：两行各 1 分、折扣 1 分）

```bash
echo '[{"op":"create_order","order_id":"o1","lines":[
  {"line_id":"a","unit_price":1,"quantity":1},
  {"line_id":"b","unit_price":1,"quantity":1}],"discount":1},
 {"op":"refund","refund_id":"r1","order_id":"o1","line_id":"b","quantity":1},
 {"op":"refund","refund_id":"r1","order_id":"o1","line_id":"b","quantity":1},
 {"op":"snapshot","order_id":"o1"}]' | python3 ledger.py
```

`allocation` 为 `{"a": 1, "b": 0}`（字典序 a 优先得折扣）；`r1` 退 1 分，
重复 `r1` 幂等不变更余额；最终 `total_refunded = 1 ≤ total_paid = 1`。
