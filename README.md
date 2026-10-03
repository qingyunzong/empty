# audit-tail-ledger

金融审计尾部增量分块解码器与 CLI（Node.js 22，仅标准库 + node:test）。

## 文件格式

账本由主数据文件与尾部清单侧车文件组成：

- `<file>`：块序列。首个块为创世锚点快照（seq 0，空状态），之后为增量块与锚点快照块的混合链。
- `<file>.manifest`：尾部清单，保存最近 N 块（容量 8）的索引 `{offset, length, startSeq, endSeq, hash}`，整体带 CRC32。
- `<file>.manifest.new`：清单临时区。更新清单时先写临时区并 fsync，再原子 rename 覆盖旧清单。

块布局（大端）：

| 字段 | 字节 |
| --- | --- |
| magic `AUB1` | 4 |
| version / type / reserved | 1 + 1 + 2 |
| startSeq / endSeq | 8 + 8 |
| prevOffset（无则全 1） | 8 |
| prevHash（SHA-256） | 32 |
| payloadLength | 4 |
| payload（JSON） | 变长 |
| CRC32（zlib.crc32，覆盖以上全部） | 4 |

锚点块 payload 为 `{state}`，增量块 payload 为 `{events}`。块哈希 = 整块字节的 SHA-256。

## 事件模型

- `{"type":"payment","id","account","amount"}`：支付，`balance += amount`。
- `{"type":"cancel","paymentId"}`：撤销支付。引用未知支付报 `UNKNOWN_PAYMENT`，重复撤销报 `ALREADY_CANCELLED`。
- `{"type":"adjust","account","delta"}`：额度调整。若调整后 `credit - balance < 0`（负可用额）则拒绝，报 `NEGATIVE_AVAILABLE`。

## CLI

```
node src/cli.js append   <file> '<event-json|json-array>'
node src/cli.js cancel   <file> <paymentId>
node src/cli.js snapshot <file>
node src/cli.js tail     <file> --n <k>
node src/cli.js verify   <file>
node src/cli.js anchor   <file>
```

- `tail --n`：先经尾部清单定位最近块；请求范围越过清单覆盖时沿前块哈希链补齐到最近的锚点快照为止，不读取更早快照。输出窗口事件、窗口起点状态、最终状态与锚点信息。
- `verify`：从创世块前向校验 CRC、哈希链、序号连续性并重放全部事件，最后核对清单与链尖一致。
- `anchor`：从链尖回溯到最近锚点；可容忍中间增量块 CRC 损坏（锚点前缀仍可读），并列出损坏块范围。
- 清单恢复：旧清单存在时优先使用旧清单并清理残留临时区；仅临时区存在且校验通过时将其改名恢复。

## 错误

错误以 JSON 输出到 stderr，退出码非 0：

```json
{"ok":false,"error":{"code":"CRC_MISMATCH","range":[3,3],"message":"..."}}
```

`code` 取值包括 `UNKNOWN_PAYMENT`、`ALREADY_CANCELLED`、`NEGATIVE_AVAILABLE`、`DUPLICATE_PAYMENT`、`BAD_EVENT`、`CRC_MISMATCH`、`HASH_CHAIN_BROKEN`、`SEQ_GAP`、`CORRUPT_BLOCK`、`MANIFEST_MISSING`、`MANIFEST_CORRUPT`、`NO_ANCHOR`、`USAGE`、`IO_ERROR`。`verify` 的 CRC 错误附带 `details.validThroughSeq`（可读前缀末尾序号）。

## 测试柱子

```
node --test
```
