# trade-replay

交易撤销分块重放库与 CLI。仅使用 Node.js 22 标准库与 `node:test`。

## 文件格式

追加式分块日志,每个块:

```
| magic "TXB1" (4) | seq (8, BE) | prevHash (32) | flags (1) | recordCount (4) | payloadLen (4) |
| payload (JSON: {records, snapshot?}) | crc32 (4, 覆盖头部+负载) | blockLen (4, 总长度) |
```

- **SHA-256 链**: 块哈希 = 整块字节的 SHA-256,下一块的 `prevHash` 引用之;两个块引用相同前向哈希判定为分叉 (`code=FORK`),拒绝自动选择。
- **CRC32**: 每块 IEEE CRC32 校验头部与负载。
- **稀疏索引**: 每 4 个块 (`SNAPSHOT_INTERVAL`) 在负载内携带一次全量状态快照,`range` 借此只解码增量区间并向前补齐基础持仓。
- **尾部截断恢复**: 最后块不完整时,`replay`/`put` 回滚到已确认前缀;块尾部长度字段损坏但未越过文件尾报告 `INCOMPLETE_BLOCK`;越界读取按损坏 (`OUT_OF_BOUNDS`) 处理。

## 记录类型

- `{"type":"credit","account","amount"}` 注入授信
- `{"type":"trade","id","buyer","seller","symbol","qty","price"}` 冻结买方授信 `qty*price`
- `{"type":"fill","trade","qty"}` 部分成交,可多次增量更新;全额撤销后拒绝成交
- `{"type":"cancel","trade"}` 恢复买方剩余冻结授信并回退已成交持仓

并发历史按块提交序号定序。

## CLI

```
node cli.js put <file> [--json '<json>' | <batch.json>]   # 追加一批记录( stdin 亦可)
node cli.js cancel <file> <tradeId>                       # 撤销交易
node cli.js replay <file>                                 # 全量重放,输出最终状态
node cli.js range <file> --from N --to M                  # 稀疏索引区间重放
node cli.js verify <file>                                 # 校验链完整性
```

成功输出 JSON,退出码 0;业务冲突(撤销后成交、超量成交、授信不足等)退出码 1;损坏或分叉退出码 2。

## 测试

```
node --test
```
