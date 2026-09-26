# 迟到负库存修复规划

根据仓库事件的**业务序号**重建库存序列（入库为正、出库为负），报告**最早出现负库存的位置**，
并给出让全程库存不为负的**最少补货方案**。仅依赖 Python 3.11 标准库。

## 运行

```bash
# 跑测试
python3.11 -m unittest discover -s tests -v

# 命令行：直接传 JSON / 读文件 / 读标准输入
python3.11 -m inventory_repair.cli --json '{"events":[{"id":"a","seq":1,"delta":-3},{"id":"b","seq":2,"delta":2},{"id":"c","seq":3,"delta":-4}]}' --pretty
python3.11 -m inventory_repair.cli --file examples/acceptance.json --pretty
cat examples/late_then_recover.json | python3.11 -m inventory_repair.cli --pretty
```

退出码：`0` 成功；`2` 输入/字段非法；`3` 重复事件 ID 内容发生变化。

## 输入格式

顶层 JSON 对象：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `events` | `[{id,seq,delta}]` | 已到达事件 |
| `late_events` | 同上，可省略 | 迟到事件；加入后与基线事件统一按 `seq` 重排 |

- `id`：非空字符串，全局唯一；
- `seq`：整数业务序号（重放顺序键；同序号按 `id` 确定性排序）；
- `delta`：整数，入库为正、出库为负；布尔值会被拒绝（`true/false` 不是合法增量）。

重复 ID 规则：`(seq, delta)` 完全一致视为重复投递，**幂等忽略**；
只要 `seq` 或 `delta` 任一变化，**拒绝**并报 `duplicate_event_conflict`（退出码 3）。

## 输出格式

- `order[]`：重排结果，每项含 1-based `slot`、`id`、`seq`、`delta`、无补货库存 `balance`、修复后库存 `repaired_balance`。
- `earliest_negative`：最早负库存点（`slot`/`event_id`/`seq`/`balance`）；无则为 `null`。
- `lower_bound`：独立前缀下界（= 最优补货总量）。
- `feasible_without_replenishment`：0 补货是否已可行。
- `replenishment`：`total` 总量、`count` 次数、`insertions[]`（`slot` 表示在该槽位事件**之前**补入）。
- `evidence`：下界、可达性、最小次数、最晚位置四段最优性证据。

## 算法与最优性

设按业务序号重排后的增量为 `d[0..n-1]`，原始前缀和 `P(i)=Σ d[0..i]`，初始库存 0。
在事件 `k` 之前插入补货 `r_k≥0`，记 `R(i)=Σ_{k≤i} r_k`，则修复后前缀库存为 `B(i)=P(i)+R(i)`，
要求对所有 `i` 有 `B(i)≥0`。

1. **独立前缀下界**：对每个前缀 `P(i)+R(i)≥0`，而 `R(i)` 是“截至该点已插入的补货”，
   必满足 `R(i)≤T`（`T` 为补货总量）。故 `T≥max(-P(i),0)`，对所有前缀取最大，得
   `T≥L:=max(0,-min_i P(i))`。该下界只依赖原始前缀，与补货方式无关，因此是“独立”下界。
2. **可达性（总量最优）**：令最早负库存事件的槽位为 `j=min{i:P(i)<0}`，在事件 `j` 之前一次性补 `L`。
   `j` 之前所有前缀原本非负；`j` 及之后每个前缀都增加 `L`，最小前缀由 `min P(i)` 变为
   `min P(i)+L=0`。全程非负，且总量恰为 `L`，故总量最优。
3. **最小次数**：`L>0` 时 0 次补货不可行，而上述构造只用 1 次，故最小次数为 1；`L=0` 时为 0 次。
4. **最晚位置**：单次补货必须不晚于“每个负前缀事件”，因此不能晚于最早负库存槽位 `j`；
   放在 `j` 仍可行，故 `j` 就是最晚（且唯一）的可行补货位置。

优化目标按字典序满足：先最小化总量（= `L`），再最小化次数（`L>0` 时为 1），最后取最晚位置序列（槽位 `j`）。

## 测试

`tests/test_planner.py` 包含：

- 验收用例 `-3,+2,-4`：总量 5、在第一个事件前补 5、0 补货不可行；
- 迟到事件插入、幂等去重、重复 ID 内容变化拒绝、字段校验、CLI 退出码；
- 一个**独立穷举器**：枚举所有可行补货分配，按“总量→次数→最晚位置序列”择优，
  与本实现逐一比对；既覆盖指定合成样本，也穷举长度 1–3、增量 ∈ [-2,2] 的全部序列。

所有数据均为合成数据。
