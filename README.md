# conveyor-monitor

输送线监控系统：在边增删下维护无向图的桥（bridge）与割点（articulation point），
用于评估单点故障。仅使用 Node.js 22 标准库，离线单机运行。

## 结构

- `src/graph.js` — 动态无向图；每次查询用迭代 Tarjan 从当前边集重算桥与割点，
  因此结果天然与"从快照重放"一致。
- `src/wal.js` — JSONL 预写日志：每行 `{"seq","op","u","v","crc"}`，
  `crc = sha256("seq|op|u|v")[0:16]`；`commit` 为检查点记录。
- `src/monitor.js` — `Monitor`：图 + WAL + 崩溃模拟 + 恢复。
- `cli.js` — 命令行入口（同时导出 `runCli` 供进程内测试）。

## 持久化与恢复语义

- 每条记录 append + fsync 后即"已确认"；恢复时重放所有完整且 CRC 校验通过的记录。
- 故障点三处：`after_append`（append 后撕断写）、`before_fsync`（fsync 前丢尾部字节）、
  `after_index_commit`（索引提交后检查点记录撕断）。`crash_sim` 向日志注入截断字节模拟。
- 恢复时尾部的半条记录（未确认）被丢弃并截断出文件——半条 `del_edge` 绝不视为删除。
- 完整记录 CRC 校验失败或无法解析 → `PERSIST_CORRUPT`。
- `recover` 输出 `{"applied","discarded","state_hash"}`，
  `state_hash = sha256(排序后边列表 "u,v" 按行连接)`。

## CLI

```
node cli.js <log-file> add_edge <u> <v>     # OK | INVALID_INPUT | PERSIST_CORRUPT
node cli.js <log-file> del_edge <u> <v>     # OK | NO_SUCH_EDGE | INVALID_INPUT
node cli.js <log-file> query_bridges        # [[u,v],...] 有序
node cli.js <log-file> query_articulation   # [v,...] 有序
node cli.js <log-file> commit               # OK
node cli.js <log-file> crash_sim <point>    # after_append|before_fsync|after_index_commit 或 1|2|3
node cli.js <log-file> recover              # {"applied":N,"discarded":M,"state_hash":"..."}
```

## 测试

```
node --test
```

规模：n≤300 顶点、m≤2000 边、≤8000 操作（见 `test/scale.test.js`）。
