# materialpub

崩溃安全的测试材料包发布库（仅 Go 标准库）。把测试日志、摘要、退出码组成
不可变材料包，全部文件落盘并重新校验后才原子发布清单。

## 布局

```
<root>/runs/<runID>/
  claim.json      # 运行ID与包摘要的持久绑定（最先写入）
  test.log        # 数据文件：tmp 写入 + fsync + 原子 rename
  summary.json
  exitcode.txt
  manifest.json   # 清单：最后原子 rename，是唯一提交点
```

## 提交流程

1. `claim.json` 持久绑定 runID → 包摘要；同 ID 异摘要的重试（无论此前
   是否发布完成）一律返回 `ErrDigestConflict`。
2. 三个数据文件各自经 `*.tmp` 写入、fsync、rename，并 fsync 目录。
3. 从磁盘重读每个文件，核对 SHA-256 与大小。
4. `manifest.json` 同样先写 tmp 再 rename —— 这是唯一提交点。

任一故障点崩溃后重启：读者通过 `Read` 只能看到完整且摘要校验通过的包，
或 `ErrNotPublished`；不会看到半成品。`Read` 还会拒绝被篡改的包
（`ErrCorrupt`）。

## 测试

```
go test ./...
```

故障注入矩阵见 `publisher_test.go` 的 `TestCrashRestartMatrix`，覆盖
`claim`、`files`、`verify`、`manifest-staged`、`manifest` 五个故障点。
最近一次实际运行结果见 `test-results.txt`。
