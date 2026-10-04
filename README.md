# causalreg — 因果向量多值寄存器（Go 标准库）

多值寄存器 CRDT：写入以因果向量（向量时钟）比较。

## 语义

- **因果后写覆盖前写**：`Write` 先合并当前全部版本的时钟再自增本副本计数，
  新写支配所有已观察版本，旧版本被丢弃（`register.go` Write）。
- **并发写全部保留**：`Merge` 取两侧版本并集，仅丢弃被其他版本因果支配
  （After）的版本；并发版本全部保留，去重相同时钟（`register.go` Merge）。
- **按 ID 展示**：`Versions`/`Values` 按副本 ID 排序输出。
- **解决冲突的写须观察全部当前版本**：`Write` 的新时钟是全部现存版本时钟
  的逐元最大值加一，因此支配所有当前版本（测试
  `TestResolvingWriteObservesAllVersions` 验证）。

## 合并性质（测试验收）

- 交换律：`TestMergeCommutative`
- 结合律：`TestMergeAssociative`
- 幂等：`TestMergeIdempotent`（重复合并、自合并、合并子集均不改变状态）
- 不丢并发写 / 任意合并次序收敛：`TestMergeOrdersConvergeAndKeepConcurrentWrites`
  枚举 3 副本全部 6 种合并次序；`TestConvergenceAfterResolution` 验证解决写后
  不同合并次序仍收敛到同一终态。

## 实际测试结果

```
$ go test ./...
ok  	causalreg	0.003s
```

8 个测试全部 PASS（go1.27.1 linux/amd64，仅使用标准库）。
