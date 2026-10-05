# auditlog

仅使用 Go 标准库实现的追加式审计日志 CLI。

## 帧格式（小端）

```
[0:4]    载荷长度 uint32
[4:12]   序号 uint64
[12:16]  头部 CRC-32(IEEE)（覆盖前 12 字节）
[16:]    载荷
[end-4:] 帧 CRC-32(IEEE)（覆盖头部+载荷）
```

头部独立校验用于区分「撕裂的尾帧」（文件在中途结束，可截断）与
「长度/序号字段被破坏」（完整但无效，绝不修改原文件）。

## 命令

```
auditlog append  <log> <seq> <payload...>  追加一帧（索引尽力更新，允许滞后）
auditlog list    <log>                     列出所有有效帧
auditlog verify  <log>                     校验全部帧；尾帧不完整仅告警，校验错失败
auditlog recover <log>                     仅截断不完整尾帧；校验错时原文件保持不变
auditlog reindex <log>                     从日志重建 <log>.idx，检测同序号不同载荷
```

## 设计要点

- **恢复**：`Recover` 唯一的写操作是把不完整的尾帧截断；任何完整帧的
  校验错误（无论中段还是尾部）都返回 `CorruptError`，原文件逐字节不变。
- **索引可滞后**：索引是派生数据，`append` 更新失败仅告警；`Rebuild`
  随时可从日志完整重建。
- **重建冲突检测**：同一序号出现不同载荷时返回 `DuplicateSeqError`；
  完全相同的重复（重试追加）被容忍，保留首次偏移。

## 验收测试

- `TestByteByByteTruncation`：对日志在 **每一个字节长度** 处截断后恢复，
  断言结果必是原日志的帧边界前缀且重扫干净。
- `TestSingleByteCorruption`：对 **每一个字节** 做三种位翻转，断言均被
  识别为 `CorruptError` 且文件逐字节未被修改。
- `TestMidLogCorruptionNeverModified`：中段校验错时 `Verify` 失败、
  `Recover` 不改动文件。
- `TestRebuildDetectsConflictingDuplicateSeq` /
  `TestRebuildToleratesIdenticalDuplicateSeq` / `TestIndexLagAndRebuild`。

## 实际测试结果

```
$ go test ./... -count=1
ok  	auditlog	0.054s
?   	auditlog/cmd/auditlog	[no test files]
```

（Go 1.27.1，linux/amd64，2026-10-05；12 个测试全部通过。）
