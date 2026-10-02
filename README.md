# wal-ledger

离线支付结算库与 CLI，基于 WAL（预写日志）保证崩溃一致性。仅使用 Node.js 22 标准库，测试使用 `node:test`。

## WAL 帧格式

每帧：`u32 长度 | u32 序号 | u8 类型 | JSON 负载 | u32 CRC32`（小端，CRC32 覆盖头部+负载）。
类型：`1` = 变更记录（TXN），`2` = COMMIT。

## 提交协议

1. 追加变更记录帧并 fsync；
2. 追加 COMMIT 帧并 fsync；
3. fsync 完成后才向客户端返回成功。

撤销仅作用于已支付且未撤销的交易，产生等额反向分录（`cancel:<id>`）；重复撤销返回 `E_ALREADY_CANCELLED`。

## 恢复

重启后扫描 WAL：CRC 错误、截断帧或无 COMMIT 的事务一律丢弃；已 COMMIT 事务重做，商户二级索引由 WAL 重建。`recover` 会将文件截断到最后一个有效帧。

## CLI

```sh
node src/cli.js pay --id t1 --merchant M1 --amount 500 [--dir DATA]
node src/cli.js cancel --id t1 [--dir DATA]
node src/cli.js audit --merchant M1 [--dir DATA]
node src/cli.js recover [--dir DATA]
node src/cli.js crash --point P1|P2 --id t1 --merchant M1 --amount 500 [--dir DATA]
```

- `crash --point P1`：变更记录落盘后、COMMIT 前退出（模拟崩溃）。
- `crash --point P2`：COMMIT 落盘后、返回成功前退出（模拟崩溃）。

错误以 JSON 对象输出到 stderr（`{"error":{"code":...,"message":...}}`）并以非零码退出。

## 测试

```sh
node --test
```
