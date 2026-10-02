# walstore

面向计量院测量系统的可审计存储：以 WAL（预写日志）为核心，每一次值变更都可审计、可重放、可证伪。
仅使用 Node.js 22 标准库，单机离线运行，测试基于 `node:test`。

## 设计

- **WAL 是唯一事实来源**。所有变更以逻辑日志追加：每条记录为
  `{seq, txn, op, device, key, oldValue, newValue}`（操作、键、旧值、新值、事务ID，
  单操作即一个事务，`txn === seq`）。磁盘格式为带校验的帧：
  `[u32 长度][u32 CRC32(载荷)][JSON 载荷]`。
- **重放（replay）**：从最新的、不超过目标序号的检查点出发，按 WAL 重放到任意事务序号，
  重建该时刻的完整状态。重放路径与实时路径共享同一份记录应用逻辑，测试证明二者状态一致。
- **二级索引只作加速**：按设备ID维护 `device -> [keys]` 索引并持久化到 `index.json`
  （带 `seq` 水印）。正确性一律以 WAL 重放为准；`audit` 命令对比持久化索引与全量重放结果，
  报告全部分歧（`index_only` / `replay_only`）。恢复时若索引水印与 WAL 不一致
  （崩溃、截断），索引自动从 WAL 重建。
- **检查点（checkpoint）**：`checkpoint.json` 保存 `{seq, state}` 快照，重放从快照续放 WAL 尾部。
- **故障注入**：`apply --crash-after write|fsync` 在每条日志写后 / 刷盘后模拟崩溃
  （进程以退出码 2 猝然退出）；`inject --truncate-at N` 把 WAL 截断到字节偏移 N，
  模拟日志中段的截断崩溃；`inject --corrupt-index` 人为破坏索引。
- **恢复**：打开存储时扫描并校验 WAL；尾部不完整帧（撕裂写）干净截断丢弃，
  截断点之前全部可重放，之后可继续追加与 checkpoint。完整帧校验和失败属于损坏，
  报错并指出偏移，停止恢复。

## CLI

```
node src/cli.js [--data DIR] <command> [options]

apply      --device D --key K (--value V | --del) [--crash-after write|fsync]
replay     [--to SEQ]            # 重建并打印 SEQ 时刻的完整状态（默认最新）
audit                            # 对比索引与 WAL 重放；分歧时退出码 1
checkpoint                       # 写检查点
inject     --truncate-at BYTES | --corrupt-index
```

`--value` 先按 JSON 解析，失败则按字符串处理。数据目录含 `wal.log`、`index.json`、`checkpoint.json`。

## 错误约定

- 重放到不存在的序号：`ERROR NO_SUCH_TXN: no transaction with sequence N (max M)`，退出码 1。
- 日志校验和失败：`ERROR CHECKSUM_MISMATCH: checksum mismatch at offset <N>`，指出偏移并停止。
- 日志不连续（checkpoint 与 WAL 之间出现空洞）：`ERROR LOG_GAP`。
- 参数错误：`ERROR USAGE`。

## 测试与验收

运行 `node --test`（或 `npm test`）。覆盖：

1. **验收场景 1**：2000 次变更（含删除、检查点、重开恢复）后 `replay --to 1234`
   与当时模型快照逐键一致；重开后重放结果相同；实时路径与重放路径在最新点一致。
2. **验收场景 2**：人为破坏 `index.json`（幻影键 + 丢键）后 `audit` 报告全部分歧，
   且 WAL 重放结果保持正确。
3. **验收场景 3**：在日志中段 `inject --truncate-at` 注入截断崩溃，重启后截断点之前
   全部可重放、之后干净丢弃（越界重放返回 `NO_SUCH_TXN`），`checkpoint` 与新变更可继续。
4. 随机序列（确定性种子 mulberry32，600 次随机 set/del + 中途 checkpoint + 模拟重启）
   与参考模型在 30 个随机探测点逐一比对。
5. 崩溃注入点（每条日志写后、刷盘后）恢复一致性；校验和失败偏移；CRC32 标准向量；
   撕裂尾帧截断后续写。

### 真实测试结果（2026-10-03，Node v22.22.1）

`node --test` 输出：

```
# tests 3        # 3 个测试文件（共 18 个用例）
# pass 3
# fail 0
# duration_ms ~10s
```

逐文件运行（`node test/<file>`）18 个用例全部 `ok`：

- `test/wal.test.js`：CRC32 向量、帧编解码回环、撕裂尾帧识别、校验和失败偏移、
  截断后续写、写/刷盘注入点钩子。
- `test/store.test.js`：验收场景 1、验收场景 2、`NO_SUCH_TXN`、校验和失败偏移并停止、
  随机序列对参考模型、`replay --to 0`。
- `test/cli.test.js`：CLI 全命令 happy path、`NO_SUCH_TXN` 退出码、验收场景 3、
  两个崩溃注入点恢复、索引破坏审计、参数错误。

## 文件结构

- `src/crc32.js` — CRC-32/ISO-HDLC（标准库实现，含已知向量测试）
- `src/wal.js` — 帧编码、扫描校验、恢复截断、带注入点钩子的追加器
- `src/store.js` — apply / replay / checkpoint / audit，索引维护与重建
- `src/cli.js` — 命令行入口（`runCli` 支持进程内调用，便于测试崩溃注入）
- `test/` — `node:test` 测试
