# bitemporal

双时态（bitemporal）版本查询库，仅使用 Go 标准库。

## 语义

- **更正记录**：每次 `Commit` 追加一批 `Correction`，覆盖业务时间半开区间
  `[From, To)`；区间为空或倒置返回 `ErrEmptyInterval`。
- **提交时间历史**：提交只增不改，commit ID 从 1 严格递增，构成提交时间轴。
- **可见性规则**：在 (业务时间 b, 提交时间 c) 处，所有 `CommitID <= c` 且区间
  覆盖 b 的更正里，最新提交者胜出；同一提交内靠后的更正胜出。
- **删除**：`Delete: true` 的墓碑同样占有有效区间，遮蔽更早提交的值；
  查询返回 `Found=false` 但仍报告来源 `CommitID`。
- **查询输出**：`Result{Found, Value, CommitID}`，CommitID 即产生该可见记录的
  来源提交。

## 实现

每个 key 的版本按 commit ID 升序追加存储；查询先二分定位 `CommitID <= c`
 的可见前缀，再顺序扫描取最后一个覆盖 b 的版本。并发安全（`sync.RWMutex`）。

## 测试

`bitemporal_test.go` 包含语义单元测试，以及与朴素二维网格模型的随机对照：
网格模型对 (业务时间 × 提交时间) 平面上每个格子从头重放全部提交得出真值，
200 组随机提交序列 × 4 个 key × 全网格逐点比对。

## 实际测试结果（go1.27.1 linux/amd64）

```
$ go vet ./... && go test ./... -v
=== RUN   TestCorrectionOverridesBusinessInterval
--- PASS: TestCorrectionOverridesBusinessInterval (0.00s)
=== RUN   TestHalfOpenBoundaries
--- PASS: TestHalfOpenBoundaries (0.00s)
=== RUN   TestDeleteHasValidityInterval
--- PASS: TestDeleteHasValidityInterval (0.00s)
=== RUN   TestCommitTimeTravel
--- PASS: TestCommitTimeTravel (0.00s)
=== RUN   TestEmptyIntervalRejected
--- PASS: TestEmptyIntervalRejected (0.00s)
=== RUN   TestSameCommitLaterCorrectionWins
--- PASS: TestSameCommitLaterCorrectionWins (0.00s)
=== RUN   TestRandomizedAgainstNaiveGrid
--- PASS: TestRandomizedAgainstNaiveGrid (0.08s)
PASS
ok  	bitemporal	0.081s
```
