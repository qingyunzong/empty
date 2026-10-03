# trade-cancel-saga

交易撤单库与 CLI。一笔成交依次占用准备金、扣除手续费、登记撮合结果；
撤单按相反顺序补偿：撤销撮合 → 退还手续费 → 释放准备金。

## 核心语义

- 每个补偿分支返回 ACK 后汇合；某分支失败时状态为 `CANCELLING`
- 重试从未完成分支继续，已 ACK 的分支幂等且不能再次退款
- `irreversible=true` 的成交拒绝撤单，返回 `IRREVERSIBLE_CONFLICT`，不产生任何部分补偿

## 文件

- `src/engine.js` — 交易引擎与补偿 saga
- `src/store.js` — JSON 快照 + 追加日志持久化
- `src/cli.js` — 可测试的 CLI 核心
- `cli.js` — CLI 入口
- `test/` — node:test 测试

## CLI 用法

```bash
node cli.js <command.json | -> <logDir>
```

命令 JSON 示例：

```json
{"op":"deposit","accountId":"alice","amount":1000}
{"op":"execute","tradeId":"t1","accountId":"alice","amount":200,"fee":10}
{"op":"cancel","tradeId":"t1"}
{"op":"cancel","tradeId":"t1","fail":["REFUND_FEE"]}
{"op":"account","accountId":"alice"}
{"op":"certificate","tradeId":"t1"}
```

错误时退出码为 1，输出 `{"error":{"code":"...","message":"..."}}`。

## 测试

```bash
node --test
```
