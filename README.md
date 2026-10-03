# freeze-ticket-log

额度冻结票据的分块事务日志与 CLI。Node.js 22，仅标准库，测试使用 `node:test`。

## 概念

- 每个 `freeze` 生成一张票据（`T-NNNNNN`）与唯一序列号（`FZ-NNNNNN`）。
- 支持部分捕获（capture）、部分释放（release）、到期释放（expire）、撤销（cancel）。
- 票据状态完全由增量事件归约得到，不直接持久化。
- 事件按块（chunk）落盘：块头包含事件序号范围、前块 SHA-256 哈希、CRC32、
  压缩增量长度；载荷为 deflate 压缩的事件数组。
- `index.json` 保存每张票据首次出现的块；每 4 个块写一次快照。
  单票解码从索引块的前序快照开始，只重放该票据的事件。
- 同一命令携带相同 `--idempotency-key` 重放时返回原结果，不二次扣减。

## 业务规则

- 总额度（`--limit` 或 `FZ_CREDIT_LIMIT`，默认 1000000）不足时拒绝 freeze。
- 捕获/释放超过剩余冻结额时拒绝。
- cancel 仅撤销未捕获的 freeze；已部分捕获时释放剩余额并生成补偿事件
  （票据状态 `compensated`）。
- 重复 expire、对已关闭票据的操作均拒绝。

## 退出码

- `0` 成功；`1` 业务错误；`2` 日志损坏。

## 恢复

写块过程中进程在 fsync 前退出会留下半截块。`recover` 只承认长度与 CRC32
完整且哈希链连续的块，删除首个坏块及其后所有块、清理失效快照并重建索引，
之后可从最近已确认状态继续追加。

## 用法

```sh
node src/cli.js freeze  --amount 100 --idempotency-key K1 [--data-dir D] [--limit N]
node src/cli.js capture --ticket T-000001 --amount 40 --idempotency-key K2
node src/cli.js release --ticket T-000001 --amount 10
node src/cli.js expire  --ticket T-000001
node src/cli.js cancel  --ticket T-000001
node src/cli.js ticket  --ticket T-000001
node src/cli.js recover
```

## 测试

```sh
node --test
```

- `test/state-machine.test.js`：12 个操作以内穷举票据状态机，与独立参考模型对照；
  另有采样序列走真实落盘日志并校验索引+快照的增量解码。
- `test/idempotency.test.js`：幂等键重放、超额捕获/释放、重复到期、额度不足、cancel 规则。
- `test/recovery.test.js`：半截块与 CRC 坏块的恢复边界。
