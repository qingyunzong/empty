# quota-ledger

额度冻结快照与增量证书库。Node.js 22,仅标准库 + `node:test`,无第三方依赖。

## 数据模型

- 账户有总额 `total` 与可用额度 `available`。
- `freeze` 生成票据(ticket),扣减可用额度;`capture` 按票据分批扣减(总额随之减少);
  `release` 将票据剩余额度恢复为可用;`undo` 撤销一笔捕获,生成反向增量。
- 不变量:`available + Σ(未释放票据 remaining) = total`。

## 文件格式

账本文件由顺序块组成:创世快照块 + 增量块,每 4 个增量追加一个快照块。

块头 60 字节(大端):

| 字段 | 偏移 | 长度 |
| --- | --- | --- |
| magic `GSB1` | 0 | 4 |
| version | 4 | 4 |
| type (1=快照, 2=增量) | 8 | 1 |
| reserved | 9 | 3 |
| offset | 12 | 8 |
| payloadLength | 20 | 4 |
| CRC32(payload) | 24 | 4 |
| prevHash (SHA-256) | 28 | 32 |

块哈希 = SHA-256(header + payload),经 `prevHash` 链接成链。版本号即状态版本(已应用增量数),快照块与其前增量同版本。

索引文件 `<file>.index.json` 记录 `latestSnapshot`、全部快照列表、每版本增量偏移与链头。证书包含:`stateRoot`(规范化状态 JSON 的 SHA-256)、`chainHash`(链头块哈希)、`snapshotOffset`、`indexHash`。

## CLI

```
node src/cli.js init     --file L --total N
node src/cli.js freeze   --file L --amount N
node src/cli.js capture  --file L --ticket T1 --amount N
node src/cli.js release  --file L --ticket T1
node src/cli.js undo     --file L --capture C1
node src/cli.js restore  --file L --version N
node src/cli.js verify   --file L
```

- `restore --version N` 只读取 N 之前最近的快照及其后的增量,绝不重放 N 之后的记录。
- `verify` 顺序解码全部块,校验 CRC32、哈希链、快照状态与索引一致性。
- 退出码:`0` 成功,`1` 业务拒绝(重复释放、超额捕获、撤销未知操作等),`2` 文件损坏(`CORRUPT`,不输出半合并状态)。

## 测试

```
node --test
```

覆盖:10 个票据操作逐版本与全量数组参考模型比对;重复释放/超额捕获/撤销未知操作拒绝;破坏中间增量后旧版本可恢复、新版本返回 `CORRUPT`。
