# budget-auth — 嵌套作用域预算授权器

纯 Python 3.11 标准库实现的预算授权库 + JSON CLI。

## 模型

- **预算（Budget）** 组成森林（嵌套作用域）。子预算共享父预算额度：
  任何分摊到某预算的额度沿祖先链各计一次；同一父预算被多条路径
  （多个子预算的分摊）触及时，只按实际分摊总量计一次，绝不重复扣。
- **规则（Rule）** 含主体、资源条件（fnmatch 模式）、时间窗
  `[start, end)`、绑定的预算与可选累计上限。
- **请求（Request）** 一次可占用多个预算，生命周期分阶段：
  `reserve`（预留，带 TTL）→ `confirm`（确认扣额，恰好一次）或
  `release`（释放）；`advance_time` 处理到期（线性化点按
  `(expiry, id)` 排序）。

## 约束求解

`budget_auth/solver.py` 把一次请求的分摊建模为层状（laminar）容量
约束下的整数分摊：

- 每个祖先链上的节点：子树分摊总和 ≤ 剩余额度；
- 每个合格预算：分摊 ≤ 规则剩余上限；
- 择优：占用预算数最少，其次按预算 id 序确定性地取字典序最大分摊
  （小 id 优先满载），结果完全确定；
- 不可满足时返回**极小不可满足约束子集**（贪心地约简到不可约），
  附带 quota/held/remaining 等可核验数值，`verify_core` 可独立复核
  其不可满足性与极小性。

## 并发与线性化

`budget_auth/interleave.py` 以显式操作交错模拟并发：每个公开操作是
原子的（其线性化点即状态变更点）。`enumerate_interleavings` 枚举保持
线程内顺序的全部短交错；`run_history` 逐步执行并在每步校验不变量
（held ≤ quota、held 与活跃预留一致）；`find_serial_witness` 用独立的
串行历史搜索验证每条并发历史可线性化。迟到确认（到期同刻或之后）
必被拒绝，且不释放他人额度。

## 持久化

`budget_auth/wal.py`：每条变更先写 WAL（带 SHA-256 校验和、fsync）
再应用。恢复时在任意写点（包括撕裂的最后一行）截断重放；记录带
单调序号，确认的扣额恰好应用一次。

## CLI

```
python3.11 -m budget_auth <<'JSON'
{"log": null,
 "commands": [
  {"op": "add_budget", "budget_id": "root", "quota": 100},
  {"op": "add_budget", "budget_id": "a", "quota": 60, "parent": "root"},
  {"op": "add_rule", "rule_id": "r1", "subject": "alice",
   "resource": "doc/*", "start": 0, "end": 100, "budget": "a"},
  {"op": "reserve", "request_id": "q1", "subject": "alice",
   "resource": "doc/1", "amount": 30, "ttl": 10},
  {"op": "confirm", "request_id": "q1"},
  {"op": "state"}
 ]}
JSON
```

操作：`add_budget` / `add_rule` / `set_quota` / `reserve` / `confirm` /
`release` / `advance_time` / `state`。指定 `"log": <path>` 时先恢复再
执行并持久化新变更。拒绝时输出 `unsat_core`（约束子集 + 数值）。

## 测试

```
python3.11 -m unittest discover -s tests -v
```

覆盖：共享父预算只计一次、部分预留失败原子回滚、配额下降与未确认
预留冲突、重复确认、到期同刻提交、恢复重放（含逐字节截断）、
≤6 预算枚举全部分摊（对拍暴力枚举）、≤4 请求短交错全枚举并与
独立串行历史搜索比对。
