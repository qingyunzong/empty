# conveyor-graph-monitor

输送线监控系统单点故障评估：在边增删下维护无向图的桥（bridge）与割点
（articulation point），操作以 JSONL 日志持久化到本机文件，支持崩溃注入与恢复。
仅使用 Node.js 22 标准库，离线单机。

## 用法

```sh
node src/cli.js <command> [args]
# 日志文件路径由环境变量 GRAPH_LOG 指定，默认 ./graph.log
```

命令：

- `add_edge u v` / `del_edge u v`：追加日志记录（write → fsync → 内存索引提交），输出 `OK`
- `query_bridges` / `query_articulation`：输出有序 JSON 列表（桥为 `[u,v]` 且 `u<v`，字典序）
- `commit`：追加 commit 记录并 fsync
- `crash_sim <after_append|before_fsync|after_index_commit>`：在故障点注入截断字节（半条 del_edge 记录，无换行、不 fsync）
- `recover`：重放已确认记录，丢弃尾部未确认半条记录（并截断文件尾部），输出
  `{"applied":N,"discarded":M,"state_hash":"<sha256>"}`

错误输出（退出码 1）：`INVALID_INPUT`（参数非法 / 自环 / 重复边 / 超规模）、
`NO_SUCH_EDGE`（删除不存在的边）、`PERSIST_CORRUPT`（完整记录校验和失败、seq 断裂、
日志与自身不一致）。

## 设计

- `src/graph.js`：无向简单图 + 迭代式 Tarjan 求桥与割点，每次变更后 O(n+m) 重算，
  与从快照重放结果一致。规模限制 n≤300、m≤2000。
- `src/log.js`：JSONL 日志，每条记录含 seq 与 FNV 双哈希校验和；恢复时完整记录
  按 seq 顺序重放，尾部无换行终止符的半条记录丢弃并截断（不视为删除）；中间完整
  记录损坏抛 `PERSIST_CORRUPT`。操作上限 8000。
- `src/cli.js`：命令分发；同时导出 `runCli(argv, opts)` 供测试进程内调用。

## 测试

```sh
node --test
```
