# offline-material-ledger

离线物料台账库 + CLI。Node.js 22,仅标准库,测试使用 `node:test`。

## 特性

- **事件类型**: 入库 `receive` / 预留 `reserve` / 发料 `issue` / 退料 `return`
- **分块追加日志**: `events.log` 由 `[u32 长度][JSON 负载][u32 CRC32]` 块组成,逐块追加并 fsync
- **快照索引**: `snapshot.json` 记录保存点偏移,先写 `.tmp` 再 `rename` 原子发布;rename 前崩溃仍使用上一快照,日志始终是事实来源
- **幂等键**: 每个事件携带客户端键,重复键返回原结果(含失败结果),不改变库存,重放后仍生效
- **层级库存**: 批次可有父批次;父批次发料按子批次可用库存精确比例消耗(整数 floor + 最大余数,创建序打破平局)
- **预留预算**: 有活跃预留的批次发料不得超过预算,发料按 FIFO 消耗预留
- **回滚**: `rollback --to S` 追加反向补偿事件(逆序)并生成回滚证书(含被补偿事件哈希),旧账目不擦除
- **错误码**: 库存/预算不足 `E_STOCK`,不存在保存点 `E_SAVEPOINT`,块损坏 `E_CRC`
- **恢复**: `recover` 在第一个损坏块处截断日志,保存点状态可恢复

## CLI

```sh
node src/cli.js receive  --dir D --batch B --material M --qty N [--parent P] --key K
node src/cli.js reserve  --dir D --batch B --qty N --key K
node src/cli.js issue    --dir D --batch B --qty N --key K
node src/cli.js return   --dir D --batch B --qty N --key K
node src/cli.js savepoint --dir D --name S
node src/cli.js rollback --dir D --to S
node src/cli.js snapshot --dir D
node src/cli.js recover  --dir D
node src/cli.js balances --dir D
node src/cli.js certificates --dir D
```

退出码: `0` 成功, `1` 业务错误(E_STOCK / E_SAVEPOINT / E_ARG), `2` 日志损坏(E_CRC)。

## 测试

```sh
node --test
```
