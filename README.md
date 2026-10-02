# quota-ledger

Node.js 22（仅标准库 + node:test）实现的额度冻结快照与增量证书库及 CLI。

## 业务模型

- 账户有 `total`（总额）与 `available`（可用）；不变量：`available + Σ未结票据剩余 = total`。
- `freeze` 生成票据并把额度从可用转入冻结；`capture` 按票据分批扣减（永久减少总额）；
  `release` 把票据剩余额度归还可用并关闭票据；`undo` 针对捕获生成反向增量（票据须仍打开）。
- 业务拒绝（重复释放、超额捕获、撤销未知操作等）抛出 `BusinessError`，CLI 退出码 1。

## 文件格式

每个账本三个文件：`ledger.bin`（块序列）、`ledger.bin.idx`（索引）、`ledger.bin.cert`（证书）。

块头 53 字节：magic(4) `LGR1`、版本 u32、类型 u8（1=快照 2=增量）、自身偏移 u32、
载荷长度 u32、载荷 CRC32 u32、前块 SHA-256(32)。块哈希 = 整块字节的 SHA-256，构成哈希链。

- 快照块：某版本完整状态 JSON（版本 0 及每 5 个版本写入）。
- 增量块：一条业务操作 JSON。
- 索引：最新快照 `{version, offset}`、全部快照列表、每版本增量块偏移。
- 证书：`{version, stateRoot, chainHash, snapshotOffset, indexHash}`，
  分别为状态根（规范化 JSON 的 SHA-256）、链哈希、最新快照偏移、索引文件哈希。

## CLI

```
node cli.js init    --total N            [--file ledger.bin]
node cli.js freeze  --amount N           [--file ...]
node cli.js capture --ticket T1 --amount N
node cli.js release --ticket T1
node cli.js undo    --op op3
node cli.js restore --version N
node cli.js verify
```

退出码：0 成功，1 业务拒绝（`code=REJECTED`），2 文件损坏（`code=CORRUPT`）。

## restore 语义

`restore --version N` 的状态由「目标版本前最近快照 + 其后的增量块」重建；
版本大于 N 的块一律不读取（遍历在首个越界块头处停止），绝不重放之后的记录。
同时，所有版本 ≤ N 的块都会做 CRC32 与哈希链校验：任一增量块损坏时，
早于它的版本可正常恢复，等于或晚于它的版本返回 `code=CORRUPT`（退出码 2），
不会输出半合并状态。

## verify

`verify` 从文件头顺序解码并校验全部块（magic、偏移、类型、链哈希、CRC32），
并交叉核对证书中的链哈希与索引哈希。

## 测试

```
node --test
```

验收覆盖：10 个票据操作逐版本与简单全量数组重放比对；重复释放 / 超额捕获 /
撤销未知操作被拒绝；破坏中间增量块后旧版本可恢复、新版本失败。
