# biospec-store

生物样本库嵌入式存储引擎与 CLI。Node.js 22、仅标准库、`node:test` 测试、单机离线。

管理样本记录：`{ id, type, date, location, status }`（样本号、类型、采集日期 `YYYY-MM-DD`、位置、状态）。支持单写事务、WAL 持久化、两个二级索引（按类型、按日期范围）、崩溃恢复与 WAL 合并（compact）。

## 运行

```bash
node --test          # 全部测试
node src/cli.js ...  # CLI（或 npm link 后用 biospec）
```

## 架构

### 磁盘布局

```
<data>/
  POINTER               # 当前代际号，compact 时原子切换（tmp + rename）
  gen-<N>/
    main.json           # 主存储快照 { walOffset, lastTxId, records }
    wal.log             # 预写日志：BEGIN/PUT/DEL/COMMIT 帧，每帧带 CRC-32
    idx/
      type.json         # 类型索引 { walOffset, lastTxId, checksum, data }
      date.json         # 日期索引 { walOffset, lastTxId, checksum, data }
```

### WAL 帧格式（小端）

```
u32 frameLen   本字段之后的字节数 = 1(type) + 4(txId) + payload
u8  type       1=BEGIN 2=PUT 3=DEL 4=COMMIT
u32 txId
u8* payload    PUT=record JSON，DEL={id} JSON，BEGIN/COMMIT 为空
u32 crc32      对 type+txId+payload 的 CRC-32 (IEEE)
```

### 事务与提交协议

单写事务模型：任意时刻只有一个写事务（进程内强制单实例 + 同步提交路径）。提交时：

1. 将 BEGIN/操作/COMMIT 帧一次性追加到 WAL 并 `fsync`；
2. 然后才应用到内存主存储与两个内存索引；
3. 每 256 个事务（及 `close()`/`compact()`/`rebuild-index()` 时）flush：原子重写 `main.json` 与两个索引文件（tmp + rename + 目录 fsync）。

### 启动恢复

1. 读 `POINTER` 确定当前代际，清理 compact 中断遗留的多余 `gen-*` 目录；
2. 加载 `main.json` 快照，从其记录的 `walOffset` 起回放 WAL：CRC 校验失败或帧不完整（撕裂写）即截断尾部；只有带 COMMIT 的事务才会应用；
3. 校验每个索引文件：文件缺失、JSON 损坏、内容校验和不符、或记录的 WAL 位点（`walOffset`/`lastTxId`）与当前 WAL 末尾不符——任一不满足即自动从恢复后的状态重建该索引并落盘，不报错。

### compact（合并 WAL 并重写索引）

崩溃安全协议：

1. 先 flush 当前状态；
2. 新建 `gen-(N+1)/`：写入全量 `main.json`（`walOffset=0`）、空 `wal.log`、重写的两个索引文件，全部 fsync；
3. **指针切换点**：原子重写 `POINTER` 为 `N+1`（tmp + rename + 目录 fsync）；
4. 删除旧 `gen-N/`。

在第 3 步之前崩溃：`POINTER` 仍指向旧代际，数据不丢，新目录在下次启动时被清理，可再次 compact。测试通过环境变量 `BIOSPEC_CRASH_BEFORE_POINTER_SWITCH=1` 在切换点前注入崩溃（子进程真实 `process.exit`）。

## CLI

```bash
node src/cli.js --data <dir> add --id S1 --type blood --date 2024-01-05 --location F1-R1 --status stored
node src/cli.js --data <dir> update --id S1 [--type t] [--date d] [--location l] [--status s]
node src/cli.js --data <dir> remove --id S1
node src/cli.js --data <dir> find --id S1
node src/cli.js --data <dir> scan [--type t] [--from YYYY-MM-DD] [--to YYYY-MM-DD]
node src/cli.js --data <dir> rebuild-index
node src/cli.js --data <dir> compact
```

`find` 输出单行 JSON；`scan` 输出按 id 排序的 JSON 数组；日期区间闭区间，可只给一端。

### 错误约定

| 场景 | stderr 码 | 退出码 |
|---|---|---|
| 重复样本号（add） | `DUP` | 2 |
| 更新/删除/查找不存在样本 | `NOT_FOUND` | 3 |
| 参数/记录非法等其他错误 | `INVALID` / `ERROR` | 1 |

索引文件被删后启动自动重建，不报错（退出码 0）。

## 查询

- `find(id)`：点查（内存主存储 O(1)）；
- `scanByType(type)` / `scan --type`：类型索引枚举；
- `scanByDateRange(from, to)` / `scan --from --to`：日期索引（有序日期数组 + 二分定位）区间扫描；
- `scan` 同时给类型与日期时取交集。所有结果按 id 排序，保证与全量扫描参考结果逐条一致。

## 测试结果（真实运行）

环境：Node.js v22.22.1，Linux x86_64。`node --test` 输出：

```
ok 1 - test/correctness.test.js   # 验收1：5000 条混合增删改，find/scan 与暴力过滤逐条一致（含中途重启恢复）
ok 2 - test/crash.test.js         # 验收2：compact 在写新文件后、切指针前注入崩溃，重启数据不丢、可再次 compact
ok 3 - test/errors.test.js        # DUP/NOT_FOUND 错误约定、WAL 撕裂尾截断、未提交事务不生效、CLI 端到端
ok 4 - test/helpers.js            # 测试辅助（无断言，被 runner 一并加载）
ok 5 - test/rebuild.test.js       # 验收3：删除索引目录重启自动重建，结果与重建前逐条相同；校验和损坏亦重建
# tests 5
# pass 5
# fail 0
# duration_ms 16087.662818
```

## 代码结构

- `src/crc32.js` — CRC-32（IEEE，查表法）
- `src/wal.js` — WAL 帧编解码、提交事务编码、回放（仅应用已提交事务）
- `src/index.js` — 类型索引与日期索引（含序列化）
- `src/store.js` — 存储引擎：事务、提交、恢复、flush、compact、索引重建
- `src/cli.js` — 命令行入口
- `test/` — `node:test` 测试；`fixtures/compact-crash.js` 为崩溃注入子进程
