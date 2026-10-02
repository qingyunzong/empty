# archive-restore

科学归档恢复系统：带宽 + 暂存盘双资源调度、保留级抢占、配额公平、事务代际回滚、证书链证据。
Node.js 22，仅用标准库与 `node:test`。

## 库

- `lib/archive.js` — `ArchiveSystem`：`request / restore / correct / evict / verify / undo`
- `lib/scheduler.js` — 精确背包放置（最大保留级加权）、请求方公平排序（完成字节亏欠 + 等待上限）、带宽时间片分配
- `lib/certs.js` — 哈希链证书（restore/evict/correct 证据，可独立重验）
- `lib/checksum.js` — 内容校验和（子卷嵌入父卷哈希）

## CLI

```
archive init    STATE --bandwidth B --staging S [--max-wait W] [--quota q1=2,q2=1]
archive request STATE --id X --size N [--checksum H] [--retention R] [--requester Q] [--parent P] [--locked]
archive restore STATE [--ticks N] [--fail-at staging|index|cert]
archive correct STATE --id X
archive evict   STATE --id X [--reason R]
archive verify  STATE
archive undo    STATE [--steps N]
```

`restore` 输出放置（placement）、带宽时间片（timeSlices）、失败原因（failures）、证书链（certificates）。

## 语义

- 每个变更命令是一个事务代际；故障点定义为写暂存 / 写索引 / 写证书三处，注入故障即整体回滚，`verify` 结果确定。
- 暂存不足时高保留级抢占低保留未锁定对象，驱逐证明写入证书链；`undo` 按代际回滚可恢复被驱逐对象。
- 更正校验和只重验该对象及依赖子卷；父卷未决不判子卷不可恢复。
- 退出码：校验和错 / 盘满 / 环依赖 → 11；故障注入中止 → 1；用法错误 → 2。

## 测试

```
node --test test/*.test.js
```
