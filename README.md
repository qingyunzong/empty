# txlog-replay

交易撤销分块重放库与 CLI。仅使用 Node.js 22 标准库与 `node:test`。

## 文件格式

日志文件由带序号的数据块顺序追加组成：

```
| magic "TXRC01" (6) | seq u64le (8) | prevHash (32) | payloadLen u32le (4) | payload (JSON) | crc32 (4) |
```

- 每块哈希 = SHA-256(header ‖ payload)，`prevHash` 链接前一块，形成哈希链；创世块前向哈希为 32 字节零。
- 每块 payload 带 CRC32 校验。
- 稀疏索引：每 8 块（seq 1, 8, 16, …）记录文件偏移，供 `range` 定位增量区间。

## 业务语义

- `put`：一笔成交（同一 `txId` 可多次部分成交，增量更新）。冻结买方授信 `qty*price`，买方持仓 +qty，卖方持仓 -qty。授信或持仓不足拒绝（`CONFLICT`，退出码 1）。
- `cancel`：全额撤销一笔已成交交易，恢复买方全部冻结授信并回退双方持仓。撤销后该交易再有成交必须拒绝。
- 并发历史按块提交序号（seq）定序。
- 两个块引用相同前向哈希但序号（或内容）不同 → 判定分叉，`code=FORK`，拒绝自动选择，不产生任何状态更新。

## 损坏处理

- 块长度字段损坏但未越过文件尾 / 文件在块中间被截断 → `INCOMPLETE`（退出码 2），已确认前缀可恢复（截掉不完整尾部后重开即可）。
- 越界通配读取（长度字段荒谬越界、magic 错误、链断裂、range 越界）→ `CORRUPT`（退出码 2）。

## CLI

```sh
node cli.js put    --file L --tx-id T --buyer A --seller B --qty N --price P [--credit A:1000] [--position B:100]
node cli.js cancel --file L --tx-id T [--credit ...] [--position ...]
node cli.js replay --file L [--credit ...] [--position ...]
node cli.js range  --file L --from N --to M [--credit ...] [--position ...]
node cli.js verify --file L
```

- 成功：stdout 输出 JSON，退出码 0。
- 业务冲突：退出码 1；损坏 / 分叉：退出码 2；用法错误：退出码 64。错误以 JSON 输出到 stderr。
- `--credit` / `--position` 提供回放前的账户基准（可重复），每次调用独立重放，进程间不共享状态。
- `range` 只解码稀疏索引覆盖的增量区间，并从最近的索引检查点向前补齐依赖的基础持仓（输出 `coveredFrom` / `backfilled` / `applied`）。

## 测试

```sh
node --test
```

覆盖：8 笔交易多笔部分成交与撤销（枚举全部 4! = 24 种撤销到达顺序比对参考结果）、分叉拒绝且无状态更新、截断重启恢复、CRC/长度字段损坏、稀疏索引区间解码。
