# dagcalc

增量 DAG 指标求值库（仅 Go 标准库）。派生指标组织为 DAG，表达式只含整数
加、减、乘与条件；输入更正按批次提交，仅重算实际依赖发生变化的闭包，同批
多源更新在单一版本下原子发布。

## 表达式

`expr.go`：`Const`、`Ref`（引用输入或其他指标）、`Add`/`Sub`/`Mul`、
比较 `Gt`/`Lt`/`Eq`（返回 0/1）、`If(cond, then, els)`（cond 非零取 then）。
`If` 只求值被选中的分支，因此指标的**活动依赖**不含未选中分支。

## 增量提交

`Graph.Commit(updates)`：

1. 应用整批输入更正，仅值真正变化的输入计入 `ChangedInputs`；
2. 版本号 +1，按缓存的拓扑序遍历指标；
3. 某指标仅当其活动依赖（上次求值实际读取的名字）与已变化集合相交时才重算；
4. 重算后值不变的指标不会向下游传播（早停裁剪）；
5. 返回 `CommitRecord{Version, ChangedInputs, Recomputed}` 并追加进历史。

所有变更在单个写锁内完成，读者经 `Snapshot`/`Get` 看到的是同一版本下的一致
快照——同次多源更新统一发布。`MetricInfo` 暴露每个指标最近重算的版本与活动
依赖；`History` 记录每次提交的重算节点。

## 与全量求值对照

`FullEvaluate()` 用当前输入从零重算整个 DAG（不改变状态），作为增量结果的
参照。`TestRandomizedAgainstFullEvaluation` 以固定种子生成 30 节点随机 DAG、
执行 60 轮随机批量更正，每轮断言：增量快照 == 全量求值、被跳过指标的值未变、
重算指标的版本号等于当前版本。

## 测试结果（实际运行）

```
$ go test ./...
ok  	dagcalc	0.006s
```

8 个测试全部通过（go1.27.1 linux/amd64）：

- `TestArithmeticAndVersions` — 基本运算、版本与重算记录
- `TestUnchangedValueCutsOffDependents` — 值未变时下游不重算
- `TestNoOpCommitRecomputesNothing` — 无实际变化的提交不重算任何节点
- `TestConditionalActiveDependencies` — 条件未选中分支的输入变化不触发重算
- `TestBatchPublishesAtomically` — 多源更正单版本原子发布
- `TestComparisons` — 比较运算
- `TestErrors` — 重复指标、更新指标名、环检测
- `TestRandomizedAgainstFullEvaluation` — 随机 DAG 增量 vs 全量对照
