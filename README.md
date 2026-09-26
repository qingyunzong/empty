# 跨批次抵扣有效期账本

积分按**批次**获得（数量 + 过期时间）；消费按**最早过期优先（FEFO，First Expire
First Out）**扣减，过期时间相同时按批次 ID 升序；退款**原路返回原扣减批次并保留
原有效期**：

- 退款时点原批次**尚未到期** → 退回该批次、重新可用，有效期不变（不延长）；
- 退款时点原批次**已经到期** → 只记 `refunded_expired`（过期退回），
  **不会重新生成可用积分**；
- 同一 `refund_id` 重复撤销 → 幂等忽略（记 warning，不重复退回）。

时间轴为整数，有效区间左闭右开：批次在 `time == expiry` 时到期。
仅使用 Python 3.11 标准库，示例数据全部为合成数据。

## 运行

```bash
python3 -m point_ledger demo                     # 内置验收样例
python3 -m point_ledger run examples/acceptance.jsonl
python3 -m point_ledger run examples/multi_batch.jsonl --now 10
cat events.jsonl | python3 -m point_ledger run -
```

退出码：`0` 成功；`1` 存在非法事件（余额不足、超退、未知引用、格式错误等）。
重复退款是幂等命中，退出码仍为 `0`。

## 输入格式

输入为 JSON Lines（每行一个事件）或 JSON 数组。按数组/行顺序处理。

| op | 必填字段 | 可选 | 说明 |
|---|---|---|---|
| `earn` | `batch_id`, `amount`, `expiry` | `time`（默认 0） | 获得一批积分，`amount>0` |
| `consume` | `consumption_id`, `amount`, `time` | — | FEFO 扣减；余额不足整笔拒绝 |
| `refund` | `consumption_id`, `amount`, `time` | `refund_id` | 原路退回；省略 `refund_id` 时按 `consumption_id:amount` 生成 |

`amount`、`time`、`expiry` 均为整数。`op` 也接受中文别名
`获得/消费/退款/撤销`。

验收样例（`examples/acceptance.jsonl`）：

```json
{"op": "earn", "batch_id": "b1", "amount": 10, "expiry": 5, "time": 0}
{"op": "consume", "consumption_id": "c1", "amount": 6, "time": 4}
{"op": "refund", "consumption_id": "c1", "amount": 6, "time": 6, "refund_id": "r1"}
```

## 输出格式

输出一个 JSON 报表（默认报表时点为所有事件中的最大时间，可用 `--now` 覆盖）：

```json
{
  "time": 5,
  "totals": {
    "earned": 10,            // 累计获得
    "available": 0,          // 当前可用
    "consumed": 0,           // 当前已消费（净额，退款会冲减）
    "expired": 10,           // 过期：未用到期 + 到期后退款
    "refunded_total": 6,     // 累计退款（有效退回 + 过期退回）
    "refunded_valid": 0,     // 退回后重新可用的部分
    "refunded_expired": 6    // 到期后退回、不重新可用的部分
  },
  "conservation": {
    "available_plus_consumed_plus_expired_equals_earned": true,
    "ok": true
  },
  "batches": [ /* 每个批次的同名字段与守恒明细 */ ],
  "warnings": []
}
```

**守恒恒等式**（逐批次及总量均成立）：

```
available + consumed + expired = earned
refunded_total = refunded_valid + refunded_expired
```

`refunded_*` 是去向说明（memo），不与上式重复占额：有效退款先回到 `available`，
随后在原有效期到期时计入 `expired`；过期退款直接计入 `expired` 并冲减 `consumed`。

验收样例的关键结果：`available=0`、`refunded_expired=6`、`expired=10`，
即到期后退回的 6 分**没有**变成新可用分。

## 作为库使用

```python
from point_ledger import Ledger

ledger = Ledger()
ledger.earn("b1", 10, 5, time=0)
ledger.consume("c1", 6, time=4)
ledger.refund("c1", 6, time=6, refund_id="r1")  # -> {"valid": 0, "expired": 6}
ledger.report(now=6)["totals"]["available"]      # -> 0
```

## 测试

```bash
python3 -m unittest discover -s tests -v
```

覆盖：FEFO 与同过期时间的批次 ID tie-break、到期前退款保留有效期、到期后退款
不复活、部分退款拆分、重复退款幂等、超退/未知引用拒绝、余额不足全有或全无、
逐批次与总量守恒、CLI 端到端（含退出码）。

## 已做的设计决定（非唯一解）

- 同一消费**部分退款**时，退款也按 FEFO 沿扣减明细逐笔返回（先回最早过期批次），
  这与“撤销按原扣减顺序回滚”的常见账本语义一致；需求未明确规定部分退款的批次
  选择顺序，此处给出明确、可测的选择。
- 余额不足、超退、未知消费/批次 ID 采用**拒绝并报错**（CLI 退出码 1），不做静默
  容忍；重复退款除外（幂等）。
- 正确性由 17 个 unittest 用例验证；未对时间/空间复杂度做形式化最优证明，
  当前实现每次消费/退款为 O(B log B)（B 为批次数），报表为 O(B)。
