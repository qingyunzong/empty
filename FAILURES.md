# 跨页与绕回故障点枚举

环形文件 = `numPages` 个 4096 字节页。页头 32 字节：magic、代际号
(generation)、页号、payloadLen、firstFrameOff、CRC32。帧 = 8 字节帧头
(长度 + 负载 CRC32) + 负载，在页负载区内连续排布，可跨页、可跨文件尾
绕回边界。

## 跨页故障点

1. **帧头跨页撕裂**：8 字节帧头被页边界切开，崩溃时可能只落盘一半。
   恢复重放时 `io.ReadFull` 失败 → 在该处截断，保留最后完整前缀。
   （`TestFrameHeaderStraddlesPageBoundary`、
   `TestRecoverTornFrameTail/PartialFrameHeader`）
2. **帧负载跨页撕裂**：负载尾部未落盘。重放时负载读不满或 CRC32
   不匹配 → 截断到最后完整帧。
   （`TestRecoverTornFrameTail/PartialPayload`、
   `TestRecoverCorruptFrameTruncatesPrefix`）
3. **大帧跨 ≥3 页**：中间任何一页损坏，整帧不可恢复；恢复从后续页
   的 `firstFrameOff` 重新对齐到下一个帧边界。
   （`TestFrameSpansMultiplePages`）
4. **页头撕裂**（magic 或页头 CRC 错）：该页视为不存在；从流尾向前
   的连续性回走在此停止，之前的数据全部丢弃——这就是"最后完整前缀"
   语义。流起始页的 `firstFrameOff` 让恢复跳过残帧尾部，从页内第一
   个完整帧头开始。（`TestRecoverTornPageHeader`）
5. **payloadLen 撕裂**：超出页容量 → 页头 CRC 必然失败（同 4）；
   非末页非满（部分写）→ 流在该页结束，不向后跳跃。
6. **页头写与负载写之间崩溃**：payloadLen 覆盖了尚未写完的负载 →
   由帧 CRC 在重放时截断（同 2）。

## 绕回故障点

7. **绕回覆盖读者持有的页**：写入前 preflight 模拟整帧占用的所有页，
   任一被 pin 即整体拒绝并返回 `ErrBackpressure`（明确背压，不产生
   部分写）；读者释放后重试成功。（`TestBackpressureOnPinnedPage`）
8. **绕回覆盖未钉住的未读数据**：写入者重新进入某页即重写页头
   （代际号 +1），该页内起始的帧全部失效，从帧队列中淘汰；慢读者
   跨页时发现页上代际号与预期不符 → `ErrDataLost`。
   （`TestWraparoundDropsLappedFrames`、
   `TestReaderDetectsGenerationOverwrite`）
9. **恢复时新旧代际页混杂**：以"有效且非空、(代际, 页号) 最大"的页
   为流尾，向前回走要求 (代际, 页号) 严格连续（跨页 0 时 代际-1），
   旧代际残页被自然排除。（`TestRecoverAfterWraparound`）
10. **绕回点位于帧中间**：帧跨文件尾到页 0。页 0 页头为新一代际且
    连续 → 正常拼读；页 0 页头撕裂 → 在绕回边界截断。
11. **代际号自身回绕**（2^32 圈）：理论上新旧代际歧义，实际需要
    写满 2^32 圈才会出现，工程上不可达；代际比较用顺序比较而非
    回绕安全比较，已在此说明。
12. **advance 两次页头写之间崩溃**：旧页已封口、新页页头 plen=0。
    恢复以最后一个非空页为流尾，空页不参与流，写入者从完整前缀
    末尾继续。

## 背压语义

- 背压是**明确**的：`Write` 返回 `ErrBackpressure`，调用方决定重试/
  丢弃/降采样；失败发生在任何字节落盘之前，不会产生半个帧。
- 帧超过 `(numPages-1) * (PageSize - 32)` 直接返回 `ErrFrameTooLarge`，
  避免无限等待。
