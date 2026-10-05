# streammerge

多源事件流合并库（仅使用 Go 标准库）。

## 语义

- **安全前缀**：输出水位 = 所有非空闲源水位的最小值；时间戳 ≤ 水位的缓冲事件构成安全前缀，按 `(TS, Source, Seq)` 全局有序发布。
- **空闲不阻塞**：`SetIdle(id, true)` 后该源不再参与水位计算；全部源空闲时水位保持不动。
- **恢复隔离**：源恢复（`SetIdle(id, false)`）时水位从已发布水位续起，不会拉低全局水位；任何源交付 ≤ 已发布水位的迟到事件都会被隔离并记录（事件、原因、隔离时的已发布水位），绝不进入输出。
- **单调性**：每个源的水位只允许前进，回退返回错误。

## API

`New`、`AddSource`、`SetIdle`、`Advance`、`Push`、`Watermark`、`Output`、`Isolated`，详见 `merger.go` 包文档。

## 测试

`merger_test.go` 覆盖：安全前缀取非空闲源最小水位、空闲不阻塞、恢复源迟到事件隔离报告、水位回退拒绝，以及虚拟事件重放（固定种子模拟 4000 步随机推送/推进/空闲/恢复），核对输出全局单调、隔离范围精确（隔离事件均 ≤ 隔离时已发布水位）、输出与隔离互斥且完备。

## 实际测试结果（go1.27.1 linux/amd64，2026-10-06）

```
$ go test ./... -v -count=1
=== RUN   TestSafePrefixIsMinOfNonIdleSources
--- PASS: TestSafePrefixIsMinOfNonIdleSources (0.00s)
=== RUN   TestIdleSourceDoesNotBlock
--- PASS: TestIdleSourceDoesNotBlock (0.00s)
=== RUN   TestRecoveredSourceLateEventsIsolated
--- PASS: TestRecoveredSourceLateEventsIsolated (0.00s)
=== RUN   TestWatermarkRegressionRejected
--- PASS: TestWatermarkRegressionRejected (0.00s)
=== RUN   TestVirtualReplayMonotonicAndIsolationScope
    merger_test.go:287: replayed 2376 events: 1796 published, 580 isolated, final watermark 2343
--- PASS: TestVirtualReplayMonotonicAndIsolationScope (0.04s)
=== RUN   Example
--- PASS: Example (0.00s)
PASS
ok  	streammerge	0.087s

$ go test ./... -race -count=1
ok  	streammerge	1.283s
```
