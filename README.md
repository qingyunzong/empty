# materiallib — 发布型材料库

仅使用 Go 标准库实现。核心保证：

- **独立尝试目录与版本**：每次发布写入 `attempts/%06d/` 全新目录，版本号取现有最大版本 +1，失败重跑绝不复用旧目录，不会混用旧日志、摘要或数据文件。
- **核验后才切换指针**：发布流程为 写全部文件 → 写 `MANIFEST.json`（路径/大小/SHA-256）→ 全量核验（哈希、大小、无多余文件）→ 通过临时文件 + rename 原子切换 `current` 指针。此前任一步失败，读者仍看到上一次完整尝试；旧版本材料全部保留。
- **读者单尝试一致性**：`Read` 只跟随 `current` 指针，校验清单版本与指针一致，并重新核验每个文件的哈希与大小、拒绝多余文件，确保返回的全部材料来自同一次完整尝试。

## 故障注入点

`FaultInjector` 支持在以下发布节点注入一次或持续故障（见 `fault.go`）：
`after_attempt_dir`、`after_files`、`after_manifest`、`after_verify`、`before_pointer`、`after_pointer`。
除 `after_pointer`（指针已切换，读者看到新的完整尝试）外，注入故障后 `current` 指针保持不变。

## 测试结果（实际运行记录）

环境：go1.27.1 linux/amd64，命令 `go test ./... -v`（另以 `-race -count=1` 复核）：

```
=== RUN   TestPublishThenRead            --- PASS
=== RUN   TestReadBeforeAnyPublish       --- PASS
=== RUN   TestOldAttemptsRetained        --- PASS
=== RUN   TestFaultBeforePointerSwitch   --- PASS  (5 个注入点子测试全部 PASS)
=== RUN   TestFaultAfterPointerSwitch    --- PASS
=== RUN   TestPersistentFaultThenRecover --- PASS
=== RUN   TestReaderDetectsCorruption    --- PASS
=== RUN   TestReaderDetectsMissingFile   --- PASS
=== RUN   TestReaderDetectsExtraFile     --- PASS
=== RUN   TestReaderDetectsVersionMismatch --- PASS
=== RUN   TestPublishRejectsBadPaths     --- PASS
=== RUN   TestPublishEmpty               --- PASS
PASS
ok      materiallib     0.033s
```

`go test ./... -race -count=1`：`ok materiallib 1.118s`。
