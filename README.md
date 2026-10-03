# freeze-ledger

额度冻结票据的分块事务日志与 CLI。Node.js 22，仅标准库与 `node:test`。

## 模型

- 每个 `freeze` 生成票据（`T000001`…）与不重复序列号，并从总额度中扣减。
- 支持部分捕获（`capture`）、部分释放（`release`）、到期释放（`expire`）、撤销（`cancel`）。
- 票据状态由增量事件归约得到：`OPEN → SETTLED / RELEASED / EXPIRED / CANCELLED`。
- `cancel` 只能撤销未捕获的 freeze；已部分捕获时先释放剩余额并生成 `compensate` 补偿事件。
- 捕获的额度永久占用配额；释放/到期/撤销把剩余冻结额退回配额。

## 存储

```
ledger/
  meta.json            # 总额度配置（首次写入）
  blocks/000001.blk    # 头: {magic, block, seqStart, seqEnd, prevHash, deltaLen, crc32}\n + deflate 事件
  snapshots/000004.snap# 每 4 块一个全量快照（含索引，自带 CRC）
  index.json           # 每个票据首次出现的块
```

- 块头含事件序号范围、前块哈希、压缩增量长度与 CRC32；块间以 SHA-256 哈希链连接。
- 增量解码从票据索引块开始，读取其前序快照后向前重放增量。
- 写块协议：写 `.tmp` → fsync → rename → fsync 目录。
- `recover` 只承认长度与 CRC 完整的块，半截块及其后续块删除，可最近确认状态继续追加。

## CLI

```sh
node src/cli.js freeze  --amount 100 --key K [--quota 1000000]
node src/cli.js capture --ticket T000001 --amount 40 --key K
node src/cli.js release --ticket T000001 --amount 10 --key K
node src/cli.js expire  --ticket T000001 --key K
node src/cli.js cancel  --ticket T000001 --key K
node src/cli.js ticket  --ticket T000001
node src/cli.js recover
```

选项：`--dir`（或 `LEDGER_DIR`）指定账本目录。同一 `--key` 重放返回原结果，不二次扣减。
退出码：`0` 成功，`1` 业务错误，`2` 账本损坏。

## 测试

```sh
node --test
```
