# 采集分片键集的可剥离差分

`example.org/dataeng/q0280` 是一个可直接导入的 Go IBLT 集合差分包。两个采集分片只交换固定单元数的摘要，ID 类型为 `uint64`。

核心安全约束：**`peeled` 只表示摘要被完全剥离，不表示两边集合相等。** 有限 64 位校验和 XOR 都可能碰撞。只有 `VerifySets` / `PeelResult.Verify` 使用宿主提供的完整 `A`、`B` 快照做精确差分后，才可能得到 `verified`。

## 摘要表

- `Config` 指定正整数 `Cells`、数量 `1<=k<=Cells` 的互异 `Seeds`、`SchemeID` 和宿主的 `HashFunc`。
- 每个 `Cell` 使用 `math/big.Int` 保存有符号计数，并保存 `uint64` 的 `KeyXor`、`CheckXor`。
- `BuildTable` 从无重复 ID 的快照构建摘要；重复 ID 会返回 `ErrDuplicateID`。
- `Insert` / `Delete` 在映射结果完整校验后，才对所有目标格同时执行计数加减和 XOR。宿主映射若返回错误数量的下标、重复下标或越界下标，整次操作被拒绝，摘要不变。
- `Subtract(a, b)` 仅在 `Cells`、种子顺序和 `SchemeID` 完全相同时允许，返回 `a-b` 的新表。

宿主哈希函数必须对同一 ID 稳定返回恰好 `k` 个互不相同且位于 `[0, Cells)` 的下标，以及一个 64 位校验值。`SchemeID` 是宿主“同一 ID 使用同一映射契约”的声明。

## 剥离与状态

- `Peel(diff, budget)` 在差表副本上工作，原摘要不变。正数 `budget` 是成功消去候选键的最大步数；候选检查、过期队列项检查和矛盾检查不耗预算。
- 每步选择当前最小候选格号。候选要求：`count == +1` 或 `-1`，`keyXor` 的校验等于该格 `checkXor`，并且 `key` 确实映射到该格。
- 使用候选前会重新检查格版本、键、方向和映射，过期队列项会被丢弃。
- `PeelStatusPeeled`：所有格的计数和两个 XOR 均为零。
- `PeelStatusIncomplete`：仍有非零格，但没有候选。`Residual` 返回残余格，不能从残余格推断具体未恢复键。
- `PeelStatusContradiction`：已输出键再次出现（包括反向出现）。候选不被消费，`Residual` 保留现场。
- `PeelStatusPaused`：预算用尽且仍有候选。`State` 非空，绑定原差表指纹、配置指纹和内部一致性校验和。

`ResumePeel(diff, state, budget)` 会验证暂停状态校验和、配置指纹以及与传入原差表的完整指纹。相同暂停状态可重复恢复，恢复使用副本，不修改暂停状态，也不重复输出已有键。`PeelResult.Keys` 是累计输出，`PeelResult.NewKeys` 只含本次调用新增的键；流式追加应使用 `NewKeys`。

## 宿主调用

完整可运行示例见 `example_test.go`。典型流程：

```go
cfg := dataeng.Config{
    Cells:    64,
    Seeds:    []uint64{0x1111, 0x2222, 0x3333},
    SchemeID: "host-hash-v1",
    Hash:     hostHash, // 宿主提供的确定性函数
}

a, err := dataeng.BuildTable(cfg, aIDs)
b, err := dataeng.BuildTable(cfg, bIDs)
diff, err := dataeng.Subtract(a, b)

result, err := dataeng.Peel(diff, 8)
for result.Status == dataeng.PeelStatusPaused {
    result, err = dataeng.ResumePeel(diff, result.State, 8)
}
if err != nil {
    // 哈希输出非法、暂停状态不一致等情况在这里返回错误。
}

verification, err := result.Verify(aIDs, bIDs)
if err == nil && verification.Status == dataeng.VerificationStatusVerified {
    // 此时 result.Keys 的正负键已经被完整快照证明为真实 A-B / B-A。
}
```

## 测试

`iblt_test.go` 使用可控宿主哈希和小集合直接差分，覆盖：

- 成功剥离、负计数格、ID `0` 的键、同一个键同时出现在两个格；
- 不可剥离残留、校验碰撞产生的假候选、XOR 全零的“假纯”摘要；
- 每个预算暂停点、累计输出不重复、恢复错误差表/配置/被篡改状态的拒绝；
- 矛盾现场保留、重复快照拒绝，以及 `peeled` 与 `verified` 的严格区分。

运行：

```sh
go test ./...
go vet ./...
```
