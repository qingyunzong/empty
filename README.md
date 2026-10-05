# auditlog

仅依赖 Go 标准库的防篡改审计日志库，支持载荷脱敏。

## 设计

- 每条记录（`Record`）保留：原载荷 SHA-256 摘要（`OrigDigest`）、脱敏后载荷
  （`Payload`，秘密区间以 `0x00` 覆写）、合并后的脱敏范围清单（`Ranges`）。
  原秘密从不写入磁盘或任何返回值。
- 记录通过 SHA-256 哈希链链接（`Hash = H(PrevHash ‖ Index ‖ OrigDigest ‖
  Ranges ‖ redacted Payload)`）。链上仅含脱敏数据，因此仅凭日志文件即可
  重放校验（`VerifyChain`），无需接触原秘密。
- `CheckOutsideUnchanged` / `VerifyRecordAgainstOriginal` 供持有原载荷的一方
  验证范围外字节未被改动。
- `MergeRanges` 校验并合并重叠/相邻范围；`ChunkRanges` 把按块给出的相对
  范围换算为全局偏移，跨块边界的相邻范围自动合并为一条。
- 存储层按帧追加：`uint32 长度 ‖ 记录体 ‖ SHA-256 校验和`，每条记录写入后
  fsync。`Open` 时逐帧扫描，遇到撕裂帧或校验和不符即截断尾部，实现断电
  恢复；非法范围（负偏移、倒置、越界）在追加前拒绝。

## 实测结果

```
$ go test ./...
ok  	auditlog	0.006s
```

10 个测试全部通过（go1.27.1 linux/amd64）：跨块范围合并、重叠/乱序合并、
非法范围拒绝（负偏移/倒置/越界）、范围外字节不变、脱敏链摘要重放与篡改
检测、原秘密不落盘、断电撕裂帧恢复、校验和损坏恢复、恢复后可继续追加、
非法范围追加不提交记录。
