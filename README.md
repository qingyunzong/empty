# artifactpub

发布库：把一次测试运行的日志（`test.log`）、摘要（`summary.json`）和退出码
（`exit_code`）组成不可变材料包，全部文件落盘、fsync 并校验后，才以原子
rename 提交清单（`manifest.json`）。

## 保证

- **全有或全无**：读者通过 `Load` 只能看到完整且校验通过的包，或
  `ErrNotPublished`。提交是单次目录 rename，崩溃不会留下半提交的包。
- **不可变**：已提交文件置为只读；`Load` 逐文件重算 SHA-256 并拒绝多余文件。
- **幂等重试**：同运行 ID、同摘要的重试被确认为 no-op；同运行 ID、异摘要
  的重试返回 `ErrDigestMismatch`，原包不受影响。
- **崩溃恢复**：`Open` 时清理 `staging/` 下的残留暂存目录；`commit.sync`
  之后的失败已提交完整包，重试按幂等确认。

## 布局

```
<root>/staging/<runID>/   暂存区，Open 时清理
<root>/bundles/<runID>/   已提交的不可变包（含 manifest.json）
```

## 用法

```go
p, _ := artifactpub.Open("/var/lib/artifacts")
digest, err := p.Publish("run-42", artifactpub.NewBundle(log, summary, exitCode))
m, files, err := p.Load("run-42")
code, _ := artifactpub.ReadExitCode(files)
```

仅使用 Go 标准库。测试：`go test ./...`
