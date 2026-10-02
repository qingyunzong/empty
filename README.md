# trade-cancel-saga

交易撤单库及 CLI(Node.js 22,仅标准库)。

- 成交顺序: `RESERVE`(占用准备金) -> `FEE`(扣除手续费) -> `MATCH`(登记撮合)
- 补偿顺序(相反): `UNDO_MATCH` -> `REFUND_FEE` -> `RELEASE_RESERVE`
- 每个补偿分支 ACK 后汇合为 `CANCELLED` 并出具证书;任一分支失败则状态为
  `CANCELLING`,重试从未完成分支继续,已 ACK 分支幂等、绝不重复退款
- `irreversible=true` 的成交撤单整体拒绝(`IRREVERSIBLE_CONFLICT`),无任何部分补偿

## CLI

```
node cli.js '<command-json>' <log-dir>
```

命令: `deposit` / `fill` / `cancel` / `ack` / `status`,例如:

```
node cli.js '{"cmd":"deposit","amount":500}' ./logs
node cli.js '{"cmd":"fill","id":"f1","amount":100,"fee":5}' ./logs
node cli.js '{"cmd":"cancel","id":"f1"}' ./logs
node cli.js '{"cmd":"cancel","id":"f1","failAt":"REFUND_FEE"}' ./logs  # 注入分支失败
node cli.js '{"cmd":"ack","id":"f1","step":"REFUND_FEE"}' ./logs
```

stdout 输出 JSON 结果;出错时退出码为 1,输出 `{"error":{"code":...,"message":...}}`。
状态持久化在日志目录(`state.json` + `events.jsonl`),重试可跨进程继续。

## 测试

```
node --test
```
