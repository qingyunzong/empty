# settle-ledger

离线结算分块日志库与 CLI（Node.js 22，仅标准库，测试用 `node:test`）。

## 文件格式

```
[block]* [index] [footer]
```

块（二进制小端）：

| 字段 | 长度 |
|---|---|
| magic `SBLK` | 4 |
| seq 序号 | 4 |
| startOffset 起始偏移 | 4 |
| prevCrc 前块 CRC32 | 4 |
| blockLen 块长度 | 4 |
| payloadLen | 4 |
| payload 事务增量(JSON) | 变长 |
| crc32 | 4 |

索引：`SIDX` + count + 每块 `{offset, length}` + CRC32；footer 固定 8 字节
（`SEND` + indexLen）。正常读取只经索引寻址，绝不全量扫描；
`decodeState(path, {fromSeq})` 可从索引指定的任意块开始增量解码。

## 命令

```
node cli.js append <file> <txId> <credit|debit> <amount>
node cli.js settle <file> <amount>     # 校验 available = balance - frozen
node cli.js cancel <file> <txId>       # 幂等；不存在/已撤销/已冻结冲突均拒绝且状态不变
node cli.js freeze <file> <txId>       # 只增冻结额，不改余额
node cli.js verify <file> [--rebuild]
node cli.js dump   <file>              # JSON 状态
```

输出均为 JSON；错误形如 `{"ok":false,"error":{"code","block","message"}}`。

退出码：`0` 成功；`1` 业务拒绝（含余额不足）；`2` 数据损坏（报告首个坏块，
坏块之后不并入状态）；`64` 用法错误。

## 崩溃恢复

故障点：数据块已写入并 fsync、索引尚未更新。`verify --rebuild` 顺序扫描块、
校验长度与 CRC32、重建索引（识别旧索引残留与撕裂索引），结果与原索引一致。

## 测试

```
node --test > result.txt 2>&1; echo $? >> result.txt
```
