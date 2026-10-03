# biobank-store

嵌入式生物样本库：单写事务 + WAL + 双二级索引，纯 Node.js 标准库（Node 22），无外部依赖。

样本记录字段：`id`（样本号）、`type`、`date`（YYYY-MM-DD）、`location`、`status`。

## 架构

```
<db-dir>/
  manifest.json            当前代际 { generation }
  data-<gen>.json          主存储快照 { walOffset, records }
  wal-<gen>.log            预写日志（begin/put/del/commit，每条带 CRC32）
  indexes-<gen>/
    by_type.json           类型索引 { walOffset, checksum, payload }
    by_date.json           日期索引 { walOffset, checksum, payload }
```

- **单写事务模型**：所有写事务经 Promise 队列串行化。事务先在内存 overlay 上校验
  （同事务内后续操作可见先前操作），再向 WAL 追加 `begin/ops/commit` 并 `fsync`，
  最后应用到主存储与两个内存索引。校验失败的事务不会触及磁盘，天然回滚。
- **WAL 恢复**：启动时从快照位点重放 WAL；CRC 校验失败或写撕裂的尾部记录被截断；
  未配对的 begin（未提交事务）被丢弃。
- **索引持久化与校验**：索引文件含内容 CRC32 校验和与构建时的 WAL 位点。
  启动时若文件缺失、校验和不符或位点与 WAL 重放终点不一致，自动从恢复后的
  状态重建并重写索引文件，不报错。
- **compact**：以新代际写入全新快照 + 空 WAL + 重写的索引并 fsync，然后原子切换
  `manifest.json`（tmp+rename）——这是唯一的提交点。在"新文件已写、指针未切换"
  之间崩溃时，旧代际完整保留，重启后清理残留文件并可再次 compact。

## 查询

- `find(id)`：点查，O(1)
- `scanByType(type)`：按类型枚举，结果按 id 排序
- `scanByDateRange(from, to)`：日期区间扫描（闭区间），按 (date, id) 排序；
  日期索引维护有序唯一日期数组，区间扫描只访问命中的日期桶

## CLI

```
node cli.js --db <dir> add --id S1 --type blood --date 2024-01-10 [--location L] [--status S]
node cli.js --db <dir> update --id S1 [--type T] [--date D] [--location L] [--status S]
node cli.js --db <dir> remove --id S1
node cli.js --db <dir> find --id S1
node cli.js --db <dir> scan --type blood
node cli.js --db <dir> scan --from 2024-01-01 --to 2024-12-31
node cli.js --db <dir> rebuild-index
node cli.js --db <dir> compact
```

错误约定：重复样本号 → `ERROR DUP`（退出码 1）；更新/删除/查找不存在样本 →
`ERROR NOT_FOUND`；索引目录被删后启动自动重建，不报错。

## 测试

运行 `node --test`（或 `npm test`）。真实结果（Node v22.22.1，本机 2026-10-03）：

```
ok 1 - acceptance 1: 5000 mixed ops, find/scan match brute-force reference
ok 2 - acceptance 2: crash mid-compact (after new files, before manifest switch)
ok 3 - acceptance 3: deleted index directory is rebuilt on startup, results identical
ok 4 - error codes: DUP on duplicate add, NOT_FOUND on missing update/remove
ok 5 - multi-op transaction is atomic: failure rolls back, nothing reaches WAL
ok 6 - WAL recovery: uncommitted tail and torn write are ignored
ok 7 - corrupt index file (checksum mismatch) triggers automatic rebuild
ok 8 - stale index walOffset (crash before close) triggers automatic rebuild
# tests 8  # pass 8  # fail 0   （另有 CLI 全流程测试 1 个通过，总耗时约 12s）
```

三个验收场景的覆盖方式：

1. **5000 条混合增删改**：确定性 PRNG 驱动约 50% add / 30% update / 20% remove，
   同步维护一份暴力参考 Map；全部样本点查、全部类型枚举、16 组日期区间扫描
   均与暴力过滤逐条比对，重启（WAL 重放路径）后再次比对。
2. **compact 崩溃注入**：`crashHook` 在新代际文件写完、manifest 切换前抛错模拟
   崩溃；重启后数据零丢失、查询与参考一致，且可再次 compact 成功并继续写入。
3. **删除索引目录**：干净关闭后删除 `indexes-<gen>/`，重启自动重建且不报错，
   逐条比对重建前后每条样本记录完全一致。
