# sched — 冲突可串行化并行调度器

`sched` 读取 N 个事务各自的操作序列（每个操作为对某键的读或写），输出一个
**按轮次组织、冲突可串行化、轮数最少**的并行执行调度。纯 Python 标准库实现
（兼容 Python 3.11+），无第三方依赖。

## 语义定义

1. **冲突**：两个操作冲突，当且仅当它们作用于同一个键，且至少有一个是写
   （read-read 不冲突）。
2. **轮次调度**：同一轮内的操作两两不冲突，可并行执行；总轮数最少。
   最少轮数等于操作级优先图的最长依赖链长度——这是轮数的下界，而
   "每个操作放在其前驱允许的最早轮"（Kahn 分层）恰好达到该下界。
3. **确定性平局裁决**：存在多个最少轮数解时，采用规范化规则——每个操作
   放入其前驱允许的最早轮；每轮内部按 `(txn_id, 操作序号)` 字典序排列。
   相同输入必然产生相同输出。
4. **不可串行化**：事务级优先图存在环时，输出
   `{"error": "NON_SERIALIZABLE", "cycle": [...]}`，`cycle` 为环上的事务 id
   序列 `[v0, v1, ..., vk]`，表示存在优先边 `v0 -> v1 -> ... -> vk -> v0`。
5. **事务内顺序**：每个事务内部操作的原始顺序在调度中严格保持（同一事务
   的第 i 个操作所在轮次严格小于第 i+1 个）。

## 输入格式

```json
{
  "transactions": [
    {"id": "T1", "ops": [{"type": "write", "key": "x", "value": 1},
                          {"type": "read",  "key": "y"}]},
    {"id": "T2", "ops": [{"type": "read",  "key": "x"},
                          {"type": "write", "key": "y", "value": 2}]}
  ],
  "order": [["T1", 0], ["T2", 0], ["T1", 1], ["T2", 1]]
}
```

- `transactions`（必需）：事务列表。`id` 为唯一字符串；`ops` 中每个操作含
  `type`（`"read"`/`"write"`）与 `key`，写操作可带任意 `value`（用于比对
  最终状态）。
- `order`（可选）：全体操作的参考串行顺序（`[txn_id, 操作序号]` 的排列，
  且不得颠倒任何事务的内部顺序）。它确定不同事务冲突操作对的方向，从而
  决定优先图；输出的并行调度与该串行顺序冲突等价。**省略时**默认串行顺序
  T1, T2, ..., Tn（此时优先图必然无环）。若要表达循环依赖场景，需显式
  提供 `order`。

## 输出格式

成功：

```json
{"rounds": [[["T1", 0], ["T3", 0]], [["T1", 1], ["T2", 0]]], "num_rounds": 2}
```

不可串行化：

```json
{"error": "NON_SERIALIZABLE", "cycle": ["T1", "T2"]}
```

## CLI 用法

```bash
python -m sched input.json      # 从 JSON 文件读取，调度 JSON 写往 stdout
python -m sched - < input.json  # 从 stdin 读取
```

退出码：`0` 成功；`1` 输入不可串行化（stdout 输出 error JSON）；
`2` 输入格式非法（stderr 输出 `INVALID_INPUT` 详情）。

库用法：

```python
from sched import schedule_transactions
result = schedule_transactions(transactions, order=None)
```

## 项目结构

- `sched/core.py` — 输入校验、优先图构建、环检测、最少轮次调度。
- `sched/cli.py` / `sched/__main__.py` — 命令行入口。
- `tests/test_handcrafted.py` — 手工用例：三事务已知最优轮数、循环依赖
  报错与环内容、并列最优的字典序裁决、CLI 端到端。
- `tests/test_random.py` — 随机小规模输入与穷举参考实现对拍。
- `tests/reference.py` — 独立穷举参考：枚举全部合法交错（优先图的全部
  拓扑序）验证最终状态一致；回溯搜索全部合法轮次分配验证轮数最少。

## 测试

```bash
python -m unittest discover -s tests -v
```

（本环境中 `python` 未链接，实际使用 `python3.11`；二者等价。）

### 真实测试结果（交付前实际运行）

- 命令：`python3.11 -m unittest discover -s tests -v`
- 环境：Python 3.11（另用 Python 3.14.4 复跑同样通过）
- 结果：**16 个测试全部通过（OK），约 2.8 秒（Python 3.11）/ 4.5 秒（Python 3.14）**
  - 手工用例 14 个：三事务最优 4 轮、2/3 事务环检测与环内容、非法
    `order` 拒绝、字典序裁决、确定性、CLI 成功/环/非法输入。
  - 随机对拍 2 个：各 1000 个随机用例（默认串行序 / 随机合法交错序），
    逐一验证轮数等于穷举最优、调度合法（划分完备、保序、同轮无冲突、
    符合字典序规范形）、最终状态与全部合法交错的串行执行结果一致；
    含环输入验证报错及环为优先图中真实闭环。
