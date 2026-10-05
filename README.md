# ringlog — 固定页环形遥测日志

纯 Go 标准库实现。变长帧存入定长页的环形文件，帧可跨页（含跨文件尾
绕回边界）；读者 pin 住正在读的页，写入者不得覆盖，空间不足时返回
`ErrBackpressure` 明确背压；页头代际号区分绕回的新旧数据；崩溃后
`Open` 校验页头与帧 CRC，恢复最后完整前缀。

## 用法

```go
l, _ := ringlog.Create("telemetry.ring", 64) // 64 页 × 4096 B
defer l.Close()
err := l.Write(frame)            // ErrBackpressure / ErrFrameTooLarge

r := l.NewReader()               // 从最老存活帧开始
defer r.Close()                  // 释放 pin
f, err := r.Next()               // io.EOF 追上写者；ErrDataLost 被绕回覆盖

l2, _ := ringlog.Open("telemetry.ring") // 崩溃恢复：最后完整前缀
```

## 文件

- `ringlog.go` — 页头编解码、写入者、背压 preflight、绕回与帧淘汰
- `reader.go` — 读者（页 pin、跨页代际校验）
- `recover.go` — 打开恢复：页头校验 → 连续性回走 → 帧重放截断
- `FAILURES.md` — 跨页及绕回故障点枚举（12 项）与对应测试
- `ringlog_test.go` — 14 个测试覆盖全部故障点

## 测试结果

`go test ./...`（另以 `-race -count=1` 验证通过）：

```
ok  	ringlog	0.025s
```

14 个测试全部 PASS：`TestRoundtrip`、`TestFrameSpansMultiplePages`、
`TestFrameHeaderStraddlesPageBoundary`、`TestWraparoundDropsLappedFrames`、
`TestBackpressureOnPinnedPage`、`TestRecoverClean`、
`TestRecoverTornFrameTail/{PartialFrameHeader,PartialPayload}`、
`TestRecoverTornPageHeader`、`TestRecoverAfterWraparound`、
`TestRecoverCorruptFrameTruncatesPrefix`、
`TestReaderDetectsGenerationOverwrite`、`TestFrameTooLarge`、
`TestReaderObservesNewWrites`、`TestConcurrentReadWrite`。
