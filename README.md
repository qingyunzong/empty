# 迟到负库存修复规划

根据仓库事件的业务序号重建库存（入库为正、出库为负），支持迟到事件
插入，报告最早出现负库存的位置，并给出词典序最优的补货方案：

1. **最小化补货总量**；
2. 总量相同则 **最小化补货次数**；
3. 前两者相同则选择 **最晚可行的补货位置序列**。

仅使用 Python 3.11 标准库（`dataclasses`、`json`、`argparse`、`unittest`）。
所有示例数据均为合成数据。

## 运行

```bash
# 从 stdin 读取 JSON
python3 inventory_repair.py < case.json
# 或指定文件、美化输出
python3 inventory_repair.py --input case.json --pretty

# 运行测试
python3 -m unittest -v
```

## 输入格式

一个 JSON 对象：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `events` | 数组 | 常规事件，元素为 `{"id", "seq", "delta"}` |
| `late_events` | 数组 | 迟到事件（可省略），结构相同 |

事件字段：

- `id`（字符串，非空）：事件唯一 ID；
- `seq`（整数）：业务序号，合并后按 `(seq, id)` 升序重建库存（同序号按 ID 字典序，保证确定性）；
- `delta`（整数）：入库为正、出库为负。

重复 ID 规则：内容（`seq`、`delta`）完全一致时幂等忽略；内容变化时拒绝处理，
输出错误 JSON 并以退出码 3 结束。

## 输出格式

成功时输出：

```json
{
  "status": "ok",
  "event_order": [{"position": 0, "id": "a", "seq": 1, "delta": -3}],
  "earliest_negative_position": 0,
  "plan": {
    "total": 5,
    "count": 1,
    "operations": [
      {"position": 0, "before_event_id": "a", "before_event_seq": 1, "amount": 5}
    ],
    "lower_bound": 5,
    "lower_bound_witness_position": 2,
    "proof": "独立前缀下界……（机器可读的完整论证）"
  }
}
```

- `earliest_negative_position`：按业务序号重放（不含补货）后最早库存 `< 0`
  的事件下标（0 基）；全程非负为 `null`。
- `plan.operations[].position`：补货插入位置，即在排序后该下标的事件之前补货。
- `lower_bound`：独立前缀下界；`lower_bound_witness_position` 为取得下界的
  前缀下标；`proof` 为针对具体数值的最优性论证。

失败时输出 `{"status": "error", "error": "...", "message": "..."}`：
`duplicate_event_id` 退出码 3，`invalid_json` / `invalid_input` /
`invalid_event` 退出码 2。

## 验收边界

事件 `-3, +2, -4`（合成数据）：前缀和 `-3, -1, -5`。

- 最小补货总量 = **5**；
- 一次在第一个事件前补 5 可行（重放后库存 `2, 4, 0`）；
- 0 补货不可行（第一个事件后库存即为 -3），总量 4 在任何位置都不可行。

## 最优性证明（独立前缀下界）

设合并排序后事件为 `d_0, …, d_{n-1}`，前缀和 `P_j = Σ_{k≤j} d_k`。

1. **下界（每个前缀独立给出）**：任何可行补货方案，对每个前缀 `j`，
   插入在事件 `j` 之前（含）的补货总量必须 `≥ -P_j`，否则重放到事件 `j`
   后库存为负。该约束不依赖其他前缀是否已被满足。因此
   `总补货量 ≥ max_j(-P_j) = -min_j P_j =: LB`
   （约定所有前缀非负时 `LB = 0`）。
2. **可达性（总量恰为 LB）**：在序列最前一次性补 `LB`，每个前缀和变为
   `P_j + LB ≥ 0`，故最小总量 = `LB`。
3. **最少次数**：`LB > 0` 时存在负前缀，0 次补货不可行；而 1 次补货
   （方案 2）已可达，故最少次数为 1。`LB = 0` 时次数为 0。
4. **最晚位置**：单次补 `LB` 插入事件 `i` 前可行，当且仅当所有 `j < i`
   的前缀满足 `P_j ≥ 0`（这些前缀得不到补货覆盖）；`j ≥ i` 时恒有
   `P_j ≥ min P = -LB`。设 `f` 为首个 `P_f < 0` 的下标，则可行位置为
   `0..f`，最晚位置为 `f`，即位置序列 `(f,)` 词典序最晚。

综上，返回的方案在 **(总量, 次数, 最晚位置序列)** 三个目标上同时最优。
测试中另以独立穷举器（枚举所有总量、次数、位置与正整数拆分）对 60 组
随机小例做了对拍，结论一致。
