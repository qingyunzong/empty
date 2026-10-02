# obs-corrections

天文台观测更正登记库与 CLI。原始观测永不删除；更正以新记录追加并指向被更正记录，
形成更正链。仅使用 Node.js 标准库（Node >= 22.2，依赖 `zlib.crc32`），单机离线运行。

## 结构

- `src/wal.js` — 预写日志。帧格式：`[u32le 长度][JSON 负载][u32le crc32(负载)]`，
  每条更正事务顺序落盘并 `fsync`。打开时截断撕裂/校验失败的尾部。
- `src/indexes.js` — 两个二级索引：按目标名（`NameIndex`）与按时间范围（`TimeIndex`，
  提交时间戳单调递增）。磁盘格式 `{ walSeq, crc, data }`，临时文件 + rename 原子替换。
- `src/engine.js` — 存储引擎。提交流程：先 WAL（fsync）→ 再内存索引 → 再磁盘索引。
  打开时以 WAL 为准全量重放；磁盘索引缺失/损坏/落后于 WAL 时自动从 WAL 重建。
- `bin/cli.js` — 命令行入口。

## CLI

```sh
node bin/cli.js correct  --db DIR --target NAME --value V [--corrects ID] [--id ID] [--ts N]
node bin/cli.js resolve  --db DIR (--target NAME | --id ID)   # 链尾（最新有效值）
node bin/cli.js view-at  --db DIR (--target NAME | --id ID) --at N  # 当时视图
node bin/cli.js chain    --db DIR (--target NAME | --id ID)   # 打印更正链
node bin/cli.js verify   --db DIR                             # 校验索引与 WAL 一致
```

- `resolve`：沿更正链取链尾（A→B→C 时返回 C）。
- `view-at`：忽略该时刻之后提交的更正，返回"当时视图"。
- `verify`：从 WAL 重建参考索引并与磁盘索引逐一比对；发现缺失/损坏/不一致即修复，
  输出 `REBUILT: <原因>`，一致输出 `OK`。
- 崩溃注入（测试用）：环境变量 `OBS_CRASH_AFTER_WAL=1` 时，`correct` 在 WAL fsync 之后、
  索引刷盘之前以退出码 42 模拟崩溃。

## 错误约定

| 错误码      | 含义                                   | 退出码 |
| ----------- | -------------------------------------- | ------ |
| `NO_TARGET` | 更正不存在的记录                       | 3      |
| `CYCLE`     | 环状更正引用（含自引用），拒绝提交     | 4      |
| `NOT_FOUND` | resolve/view-at/chain 的目标未知       | 5      |
| `DUP_ID`    | 记录 id 重复                           | 6      |

错误码打印到 stderr，进程以对应退出码结束。

## 崩溃恢复

WAL 是唯一权威数据源。重启后重放 WAL 重建内存状态；磁盘二级索引文件若缺失、
CRC 校验失败或 `walSeq` 落后于 WAL，则从 WAL 重建并原子落盘。索引刷盘前崩溃
（见上文注入开关）重启后 `verify` 通过。

## 测试

```sh
node --test
```

真实运行结果（Node v22.22.1，2026-10-03）：

```
ok 1 - acceptance 1: chain A->B->C, resolve returns C, view-at(B time) returns B
ok 2 - NO_TARGET when correcting a nonexistent record
ok 3 - CYCLE rejected: self-reference and pre-existing cyclic data
ok 4 - acceptance 2: crash after WAL flush, before index flush -> verify passes after restart
ok 5 - corrupt index files are rebuilt from WAL and verify passes
ok 6 - torn WAL tail is truncated on recovery
ok 7 - acceptance 3: 300 random corrections cross-checked against brute-force reference
ok 8 - time index supports range queries
ok 9 - CLI end-to-end: correct/resolve/view-at/chain/verify
# tests 9
# pass 9
# fail 0
```

三个验收场景分别对应测试 1（A→B→C，resolve=C，view-at(B时刻)=B）、
测试 4（索引刷盘前注入崩溃，重启后 verify 通过）与
测试 7（固定种子的 300 条随机更正与暴力扫描参考实现逐条对照 resolve/view-at）。
