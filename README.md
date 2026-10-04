# mirrorstore — 三副本镜像文件库

仅使用 Go 标准库实现。每个键的记录在三个本地副本目录中各存一份，
记录携带**版本号**与 **SHA-256 校验和**（JSON 文件，原子写入：
临时文件 + fsync + rename）。

## 不变量

- **多数同版本才成功**：`Read` 只有在 ≥2 个副本持有校验和有效且
  版本相同的记录时才返回数据，否则返回 `ErrNoMajority`（三个副本
  版本两两不同）或 `ErrNotFound`（全部缺失），并附带逐副本证据。
- **读修复不覆盖更高版本**：读成功后修复缺失/损坏/过旧的副本；
  修复写入前会重新检查副本文件，凡版本 ≥ 多数版本（或同版本且已
  健康）的一律跳过（`SkippedHigher`），即使该记录已损坏也不覆盖
  更高版本。
- **新写严格递增**：`Write` 要求版本严格大于所有副本（含可解析的
  损坏记录）中的最高版本，否则返回 `ErrVersionRegression`。
- **副本版本单调**：所有落盘写入（`Write` 与读修复）都经过上述
  检查，单个副本的版本只增不减；测试通过 `afterWrite` 钩子记录
  每个副本的写入序列并断言严格递增。

## 返回证据

`Read` 返回的 `ReadResult.Evidence` 对每个副本给出：状态
（ok/missing/corrupt/stale）、观测到的版本、校验和是否匹配、
存储负载的 SHA-256 摘要、是否被修复、是否因更高版本被跳过。

## 测试覆盖（mirror_test.go）

- 多数一致读取成功并校验证据字段
- 损坏副本（校验和不匹配）的枚举与修复
- 缺失副本的枚举与修复
- 过旧（stale）副本的修复
- 三副本版本互不相同 → 无多数，返回证据且不修复
- 键全部缺失 → `ErrNotFound`
- 副本已持更高版本 → 修复跳过不覆盖
- **修复途中写入**：用 `beforeRepairWrite` 钩子在修复写入前注入
  外部更高版本写入，断言修复不覆盖它
- 写入版本严格递增（等版本、回退、损坏高版本记录均被拒绝）
- 并发读写压力测试：断言每个副本的写入版本序列严格递增、
  最终全部收敛

## 实际测试运行记录

环境：go1.27.1 linux/amd64。因默认构建缓存目录只读，设置
`GOCACHE=/tmp/gocache GOPATH=/tmp/gopath` 后运行。

```
$ go test ./...
ok  	mirrorstore	0.033s

$ go test -race -count=1 -v ./...
=== RUN   TestReadMajoritySuccessAndEvidence
--- PASS: TestReadMajoritySuccessAndEvidence (0.00s)
=== RUN   TestReadRepairCorruptReplica
--- PASS: TestReadRepairCorruptReplica (0.00s)
=== RUN   TestReadRepairMissingReplica
--- PASS: TestReadRepairMissingReplica (0.00s)
=== RUN   TestReadRepairStaleReplica
--- PASS: TestReadRepairStaleReplica (0.00s)
=== RUN   TestReadNoMajorityReturnsEvidence
--- PASS: TestReadNoMajorityReturnsEvidence (0.00s)
=== RUN   TestReadNotFound
--- PASS: TestReadNotFound (0.00s)
=== RUN   TestRepairNeverOverwritesHigherVersion
--- PASS: TestRepairNeverOverwritesHigherVersion (0.00s)
=== RUN   TestRepairDoesNotClobberWriteDuringRepair
--- PASS: TestRepairDoesNotClobberWriteDuringRepair (0.00s)
=== RUN   TestWriteStrictlyIncreasing
--- PASS: TestWriteStrictlyIncreasing (0.00s)
=== RUN   TestConcurrentWriteAndRepairVersionsMonotonic
--- PASS: TestConcurrentWriteAndRepairVersionsMonotonic (0.07s)
PASS
ok  	mirrorstore	1.111s

$ go vet ./...   # 通过，无输出
$ gofmt -l .     # 通过，无输出
```

注：首轮 `go test ./...` 曾暴露一个真实缺陷——修复前复查把
"同版本但校验和损坏"的记录也当作更高版本跳过，导致损坏副本
不被修复（`TestReadRepairCorruptReplica` 失败）。已将跳过条件
修正为仅"更高版本"或"同版本且校验和有效"，随后全部通过。
