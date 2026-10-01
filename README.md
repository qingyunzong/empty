# kvstore

单文件追加日志（JSONL）的键值存储，支持嵌套事务（最多 3 层）与故障注入，
纯 Python 标准库实现（3.11+）。

## CLI

```
python -m kvstore run script.json [--inject faults.json] [--replay] [--log PATH]
```

- `script.json`: 步骤列表（或 `{"steps": [...]}`），每步为
  `{"op": "begin"|"put"|"del"|"commit"|"rollback", "key": ..., "value": ...}`。
- 每执行一步输出一行 JSON：`{"step": i, "op": ..., "ok": true, "view": {...}}`；
  失败步骤带 `"ok": false` 与 `"error": "E_TXN" | "E_IO" | "E_CORRUPT"`。
- `--replay`: 运行结束后重新扫描日志恢复，输出
  `{"event": "replay", "view": {...}, "corrupt_tail_truncated": bool}`。
- 任何步骤失败或模拟崩溃，退出码为 3；否则为 0。

## 故障注入

`faults.json` 将故障点映射到触发步号（int 或列表），每个故障只触发一次后失效：

```json
{"append_before": 1, "append_after": 2, "fsync_fail": 5, "crash_after_commit": 7}
```

- `append_before` / `append_after`: 追加日志记录前/后失败（E_IO）。
- `fsync_fail`: 最外层 commit 落盘同步失败，整个事务 ABORT，日志截断到事务
  起点，不产生任何部分可见。
- `crash_after_commit`: commit 记录已追加并 fsync 后模拟崩溃；`--replay`
  恢复后该事务的全部键可见。

## 语义

- 事务帧栈最深 3 层，第 4 层 `begin` 报 `E_TXN`。
- 内层 `commit` 合并进父帧，仅最外层 `commit`（append + fsync）是持久化点。
- 内层 `rollback` 只撤销本层写入；已提交的外层结果保留。
- 恢复时只应用带最外层 commit 记录的事务；扫描到损坏尾记录即截断文件，
  之前已提交的记录保留（stderr 报告 `E_CORRUPT`）。

## 测试

```
python -m unittest discover -s tests -v
```

16 个测试覆盖：三层嵌套回滚中层（对照手工参考视图）、fsync_fail 整事务
中止且旧值保留、crash_after_commit 重放可见全部键、尾半写截断恢复、
故障一次性失效、E_TXN 错误与退出码 3。
