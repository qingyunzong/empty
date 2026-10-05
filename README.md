# datalog

Go 标准库实现的有限、无函数、正 Datalog 规则库。

## 特性

- **有限正 Datalog**：项仅为常量或变量（无函数符号）；规则要求安全性
  （头部变量必须在体中出现），保证最小模型有限。
- **关系元数至多 3**：`MaxArity = 3`，事实与规则在写入前校验，超限即拒绝。
- **递归删除**：事实仅通过 `DB.Apply(adds, dels)` 批量变更；每次变更后从空
  解释出发对剩余基本事实重算最小不动点，因此仅依靠互相支撑（循环支持）
  的事实在支撑被删除后不会保留。
- **有限推导**：模型中每个事实附 `Derivation` 证明树（基本事实为叶子），
  通过 `DB.Explain` 查询，`Depth`/`Leaves` 可检查。
- **批量原子性**：`Apply` 先校验整批事实，任一非法则整批拒绝、库状态不变。

## API 摘要

- `New()` 建库；`AddRule(R(A(...), A(...), ...))` 装规则。
- `Apply(adds, dels []Fact)` 原子批量增删基本事实。
- `Holds` / `Facts` / `BaseFacts` / `Query(A(...))` 查询模型。
- `Explain(f)` 返回事实的有限推导树。
- `Evaluate(base, rules)` 独立的从空最小不动点求值器，供核对。

## 测试结果（实际记录）

环境：go1.27.1 linux/amd64，命令 `go test ./...`（GOCACHE=/tmp/gocache）：

```
ok  	datalog	1.757s
```

6 个测试全部通过，其中 `TestRandomBatchesMatchReference` 对 200 个随机
原子批次逐步与测试内独立实现的"从空最小不动点"参考模型逐一核对一致。
