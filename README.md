# tombstone-ledger

交易撤销墓碑账本库及 CLI。Node.js 22，仅标准库与 `node:test`，无第三方依赖。

## 模型

- 每个事件带唯一 `id`、`prev`（前置因果哈希），内容哈希为 SHA-256（规范化 JSON）。
- `trade`：业务成交号 `tradeId`。
- `cancel`：额外携带所观察成交哈希 `tradeHash`；生成墓碑。
- `restore`：额外携带所观察撤销哈希 `cancelHash`；必须观察到撤销，否则拒绝（`restore-without-cancel`）。
- 因果过去 = `prev` 与观察引用（`tradeHash`/`cancelHash`）的传递闭包。
- 墓碑集合语义：撤销产生墓碑；因果上位于撤销之后的恢复清除该墓碑；同一成交的并发撤销归约为同一墓碑（最小哈希），重复事件幂等；已被因果清除的旧撤销重放不会再次撤销已恢复成交；恢复与撤销互为并发（未相互观察）则报 `conflict`。
- `merge` 先按拓扑序（深度、哈希）排序，在克隆上模拟应用，全部成功才提交（原子）。

## CLI

```sh
node cli.js trade <tradeId>     # 登记成交
node cli.js cancel <tradeId>    # 撤销（生成墓碑）
node cli.js restore <tradeId>   # 恢复（观察当前墓碑）
node cli.js merge <file>        # 合并另一账本文件（JSON）
node cli.js get <tradeId>       # 查询状态
```

- 账本文件默认为 `./ledger.json`，可用环境变量 `LEDGER_FILE` 覆盖。
- 输出均为 JSON；错误输出 `{"error":"code"}` 且退出码为 1。
- 错误码：`usage`、`invalid-input`、`invalid-event`、`unknown-trade`、`duplicate-trade`、`duplicate-event-id`、`missing-dependency`、`restore-without-cancel`、`conflict`。

## 库

```js
const { Ledger, LedgerError, hashEvent } = require('./src/ledger');
const ledger = new Ledger();
ledger.addEvent({ id, type: 'cancel', tradeId, tradeHash, prev });
ledger.getTrade(tradeId); // { tradeId, state: 'active'|'cancelled', tombstone }
ledger.merge(events);     // { added, duplicates }，冲突时抛 LedgerError('conflict') 且不提交
```

## 测试

```sh
node --test --test-reporter spec
```

测试枚举成交/撤销/恢复事件的所有拓扑顺序，并与测试内独立的集合式参考实现逐前缀对照墓碑与状态。
