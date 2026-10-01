# budget_auth — 嵌套作用域预算授权器

Python 3.11 标准库实现，无第三方依赖。

## 模型

- **预算（Budget）**：组成森林（至多一个父预算）。对子预算的占用会沿祖先链
  各计一次——同一父预算无论经多少条路径（多条规则、多个子预算）到达，只计一次。
- **规则（Rule）**：主体、资源条件（精确或 `"*"`）、闭区间时间窗 `[start, end]`，
  指向一个预算。一个请求可匹配多条规则，候选预算集合去重。
- **请求（Request）**：一次预留可分摊到多个预算，随后进入
  `active → confirmed | released` 阶段；`expires_at < now` 的预留在下一个
  线性化点被惰性置为 `expired`。`now == expires_at` 的确认仍然有效。

## 分摊求解（`budget_auth/solver.py`）

容量约束是层流（laminar）族：每个预算约束其子树占用总和。贪心填充对该族达到
最大总量，因此子集可行性由确定性贪心拆分判定。择优策略：

1. 占用预算数最少；
2. 按排序后预算 id 元组的字典序取首个可行子集；
3. 子集内按 id 序贪心拆分（每个预算取祖先约束允许的最大值）。

拒绝时返回不可满足约束子集及可核验数值：候选预算的祖先闭包上每个预算的
`quota / used / available`，以及 `requested / allocatable / deficit`，
其中 `requested > allocatable` 即机器可核验的不可满足见证。

## 并发与线性化点

并发以显式操作交错模拟：每个 `apply` 调用即该操作的线性化点。时钟前进
（`now`）先触发到期清扫，再执行操作，因此"到期"与"确认"的交错顺序完全由
操作序列决定。过期预留的迟到确认被拒绝（`invalid_status/expired`），只改动
自身状态，不释放他人额度。`budget_auth/reference.py` 是独立实现的参考模型
（暴力枚举全部分摊 + 串行历史搜索 `find_serial_history`），测试对 ≤6 预算、
≤4 请求枚举全部短交错，逐操作比对结果与最终状态。

## 持久化

每个被接受的变更操作追加一条 JSONL 记录（flush + fsync）；时钟前进以 `tick`
记录持久化，即使触发它的操作被拒绝。`Authorizer.recover(path)` 从任意一致
前缀重放恢复；确认的扣额是 holds 的纯函数，重放不会重复扣减，重复的 confirm
记录在重放中为幂等空操作。

## CLI

```sh
python3.11 -m budget_auth.cli --db state.log --script ops.json   # 应用脚本
python3.11 -m budget_auth.cli --db state.log --recover-only      # 仅恢复并打印状态
```

脚本格式 `{"ops": [...]}`，操作：`add_budget / add_rule / set_quota /
reserve / confirm / release / tick / snapshot`（均可带 `now`）。
输出 `{"results": [...], "state": {...}}`。

## 测试

```sh
python3.11 -m unittest discover -s tests -v
```

覆盖：共享父预算多路径去重、部分预留失败原子回滚、配额下降与未确认预留冲突、
重复确认、到期同刻提交、迟到确认不释放他人额度、任意写点恢复与重放幂等、
≤6 预算 / ≤4 请求的全分摊与短交错枚举对照独立串行历史搜索、CLI 端到端。

最近一次运行：34 个测试全部通过（见下）。

```
Ran 34 tests in ~16s
OK
```
