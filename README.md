# bilateral-net-settlement

Node.js 22 标准库实现（零依赖、单机离线）：双边交易净额结算 + 压缩位置索引。

## 功能

- **交易**：`{ id, buyer, seller, amount, desc, state }`，state ∈ `active | revoked | deleted`。
- **压缩位置索引**：对 `desc` 分词建位置倒排；段文件为 varint 差值编码 + gzip（`index/seg-<id>.gz`）。支持短语查询与近邻查询（NEAR/k，最小命中窗口，窗口相同按 id 最小者优先）。
- **净额结算**：撤销/删除/新增交易时重算该买卖双方全部存活交易的净额、方向与保证金冻结额（默认 10%）。净额反转时，原方向冻结的释放与新方向冻结在**同一个原子批次**中提交（先校验、后落账，任一失败全部回滚）。
- **删除**：先写墓碑（`index/tombstones.json`），段内死位置占比超过阈值（默认 0.5）时 `compact` 压缩重写段并清除墓碑。
- **查询证书**：每次查询返回证书，含命中、使用的压缩段清单（id、文件、位置数、死位置、墓碑）及结果 SHA-256 哈希。
- **错误**：未知交易、重复删除、负/零/非有限金额、重复 id、非法状态均报错且不产生任何状态变化。

## 库用法

```js
import { TradeStore } from './src/store.js';
const store = TradeStore.open('./data', { marginRate: 0.1, compactionThreshold: 0.5 });
store.addTrade({ id: 'T1', buyer: 'A', seller: 'B', amount: 100, desc: 'quick brown fox' });
const cert = store.revokeTrade('T1');        // { net, direction, reversed, batch, ... }
const q = store.phraseQuery('quick brown');  // { hits, segments, hash, ... }
const n = store.nearQuery('quick fox', 5);   // { hits, bestWindow, best, ... }
store.deleteTrade('T1');
store.compact();
store.save();
```

## CLI

```
node src/cli.js add --id T1 --buyer A --seller B --amount 100 --desc "quick brown fox"
node src/cli.js revoke --id T1
node src/cli.js delete --id T1
node src/cli.js phrase "quick brown"
node src/cli.js near "quick fox" --k 5
node src/cli.js pair --a A --b B
node src/cli.js account --name A --balance 1000
node src/cli.js compact
node src/cli.js segments
# 全局选项：--dir ./data --margin-rate 0.1 --threshold 0.5
```

## 测试

```
node --test
```
