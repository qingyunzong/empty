# order-event-store

Node.js 22 标准库实现的订单事件流存储，单机离线，无第三方依赖。

## 功能

- 事件流追加：事件含 `id`、`tradeId`、`fee`、`refundBudget`、`text`、`state`，JSONL 段文件持久化，追加即 fsync。
- 文本位置索引：对 `text` 建词项-位置倒排索引，支持短语查询（`phraseQuery`）与无序近邻查询（`nearQuery(terms, window)`，存在长度 ≤ window 的窗口覆盖全部词项）。
- 撤销退款：`undoTrade(tradeId)` 一次性退还该交易全部未退费用；超过剩余 `refundBudget` 则一分不退并抛 `INSUFFICIENT_BUDGET`；未知交易抛 `UNKNOWN_TRADE`。
- 删除与合并：删除先写墓碑记录；段存活率低于 `mergeThreshold` 时可触发段合并压缩。合并以新清单文件（`manifest.json`，tmp+rename 原子提交）为准；清单缺失或半写时回退 `manifest.json.bak`（旧段），两者皆不可用则扫描全部段文件。合并期间查询在旧段/新段上结果一致。
- 崩溃恢复：段末尾撕裂行被容忍；退款记录持久化，重启后预算剩余保持一致。

## 库用法

```js
import { OrderStore } from './src/store.js';

const store = await OrderStore.open('./data', { mergeThreshold: 0.5, autoMerge: true });
store.addEvent({ id: 'e1', tradeId: 't1', fee: 10, refundBudget: 100, text: 'hello world', state: 'open' });
store.phraseQuery('hello world');      // ['e1']
store.nearQuery(['hello', 'world'], 3); // ['e1']
await store.delete('e1');               // 先写墓碑
store.undoTrade('t1');                  // { tradeId, refunded, budget, budgetRemaining }
await store.merge();
await store.close();
```

## CLI

```
node src/cli.js <datadir> append            # 从 stdin 读 JSONL 事件
node src/cli.js <datadir> event '<json>'
node src/cli.js <datadir> delete <id>
node src/cli.js <datadir> undo <tradeId>
node src/cli.js <datadir> phrase "<text>"
node src/cli.js <datadir> near <window> <term...>
node src/cli.js <datadir> merge | liveness | report
```

退出码：0 成功；2 业务错误（stderr 打印 `ERROR <CODE>`）；1 其他错误。

## 测试

```
node --test
```
