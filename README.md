# layered-settlement

分层结算分块存储与索引恢复库及 CLI（Node.js 22，仅标准库，测试使用 `node:test`）。

## 分层模型

结算分为四层，每层作为一个块（chunk）追加到数据文件，只保存相对上一层的增量：

- `reserve` 预约：只占用预算（`reserved += amount`，允许携带 `credit` 事务注入资金/预算）
- `freeze` 冻结：扣减可用额度（`available -= amount`，`frozen += amount`）
- `pay` 实付：扣减余额（`frozen -= amount`，`balance -= amount`），必须引用对应冻结事务
- `revert` 撤销：撤销实付时先恢复对应冻结链路（`frozen` 回补）再退回余额；
  只能撤销检查点之后层级的实付（`pay.seq > lastCheckpointSeq`）

另有 `checkpoint` 块保存全量状态快照。

## 块格式

```
magic(4 "SLYR") version(1) kind(1) seq(8) parentHash(32) txSetHash(32) payloadLen(4) payload(JSON) crc32(4)
```

每个块包含：层级（seq/kind）、父层哈希、事务集合哈希、偏移（由索引记录）与 CRC32。
块哈希为整个块字节的 SHA-256。索引文件 `<data>.idx` 为 JSONL：`{seq, offset, hash, kind}`。

## 提交与崩溃语义

- 层内任一事务校验失败 → 整层不提交（先在内存中应用，成功后才写盘）
- 提交流程：先追加数据块，再追加索引行；崩溃时可能出现：
  - 孤儿块：数据完整但未链接进索引 —— `verify` 会列出，恢复绝不并入状态
  - 撕裂写：尾部不完整字节 —— 扫描时报告 `tornBytes`，忽略

## 恢复与校验

- `restore`：从创世全量重放，任何损坏即失败（退出码 2）
- `restore --checkpoint`：定位最近检查点块 + 后续增量解码，不重放全文件；
  遇到损坏增量时停在最后一个完好层级（`stoppedAtCorruption`），退出码 0
- `restore --checkpoint --to N`：必须到达第 N 层，路径上有损坏即失败（退出码 2）
- 索引指向的偏移处层号或哈希不符 → 按索引损坏处理（退出码 2）
- 数据层损坏而检查点早于损坏层时，旧检查点仍可恢复

## CLI

```
node src/cli.js <cmd> <file> [options]
  reserve|freeze|pay|revert  --tx credit:<acct>:<amt>[:id]
                             --tx reserve:<acct>:<amt>[:id]
                             --tx freeze:<acct>:<amt>[:id]
                             --tx pay:<acct>:<amt>:<freezeId>[:id]
                             --tx revert:<payId>[:id]
                             或简写 --account A --amount N [--ref ID] [--id ID]
  checkpoint
  restore [--checkpoint] [--to SEQ]
  verify
```

退出码：`0` 成功，`1` 业务错误（额度不足、撤销检查点之前的实付等），`2` 数据/索引损坏。

## 测试

```
node --test
```

验收覆盖：

1. 逐层提交 10 层，每层提交后从文件全量重算状态并与内存参考比对
2. 构造部分层写入后崩溃：链上无半层，孤儿块可报告且不并入状态
3. 中间层 CRC 损坏：旧检查点可恢复（退出码 0），跳至损坏层及以后失败（退出码 2）
