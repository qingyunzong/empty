# wal_kv — 带 WAL 的页式键值库（ARIES 恢复）

纯 Python 3.11 标准库实现。多笔事务可交错写入，在任意落盘点中断后，
`recover()` 将数据库恢复到有据可查的一致状态。

## 接口

`Database`（`wal_kv/db.py`）提供：
`begin / get / put / delete / commit / abort / checkpoint / recover`。

## 设计要点

- **日志记录**：`uint32 长度 + uint32 CRC32 + JSON 载荷`，字段含 LSN、
  事务 ID、事务前驱（prev）、页号、键、前后镜像；CLR 额外带
  `undoNextLSN`；end-checkpoint 记录携带 ATT/DPT 快照。
- **Steal / no-force 缓冲池**：脏页可早于事务提交写出（写页前按 WAL
  规则先同步日志）；`commit` 返回前只强制同步日志，不刷页。
  每页保存 pageLSN。
- **生理（physiological）日志**：前后镜像按页内单键记录，配合严格
  2PL 键锁（冲突写抛 `LockError`），保证同事务页交错时撤销正确。
- **恢复三段**：分析（从最近模糊检查点重建 ATT/DPT）→ 按 pageLSN
  幂等重做 → 沿事务链撤销未提交事务。撤销写 CLR，恢复中再次崩溃
  经 `undoNextLSN` 跳过已补偿记录，绝不重复撤销。
- **模糊检查点**：`begin_ckpt` 后快照 ATT/DPT 写入 `end_ckpt`，期间
  不阻塞写入；只有在检查点与所需日志全部持久化后，才按
  `min(DPT recLSN, 活动事务首 LSN)` 回收日志前缀。
- **日志完整性**：尾部不完整/撕裂记录直接截掉；中段 CRC 损坏抛
  `LogCorruptionError` 并保持原文件不变。
- **故障注入**：`InMemoryFileAdapter.arm(boundary, at_call)` 可在
  `log_write / log_sync / page_write / clr_write / ckpt_publish`
  每个边界注入崩溃；日志写先落易失缓冲，`sync_log` 才持久，
  `crash()` 丢弃未同步数据，模拟断电。

## 运行测试

```sh
python3.11 -m unittest discover -s tests -v
```

覆盖：两事务改同页一提交一撤销、撤销中再次崩溃、检查点与提交交错、
连续两次恢复、日志回收后恢复、尾部截断与中段损坏、五个边界的故障
注入，以及随机合法事务历史对独立串行提交模型的核对。

## JSON CLI

```sh
echo '{"script": [
  {"op":"begin","txn":"T1"},
  {"op":"put","txn":"T1","key":"a","value":"1"},
  {"op":"commit","txn":"T1"},
  {"op":"begin","txn":"T2"},
  {"op":"put","txn":"T2","key":"b","value":"2"},
  {"op":"checkpoint"},
  {"op":"crash"},
  {"op":"recover"}
]}' | python3.11 -m wal_kv.cli
```

支持的 op：`begin / get / put / delete / commit / abort / checkpoint /
flush / arm / crash / recover`。输出 JSON 包含每条命令结果、恢复轨迹
（每个动作附理由）及最终库状态。
