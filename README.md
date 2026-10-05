# material-ledger

离线物料台账库及 CLI。Node.js 22,仅标准库,测试使用 `node:test`。

## 功能

- 事件:入库 `receive`、预留 `reserve`、发料 `issue`、退料 `return`
- 追加式分块日志 `events.log`,每块 `magic(4) + length(4) + crc32(4) + JSON payload`
- 每条命令带客户端幂等键;重复键返回原结果且不改变库存(含 E_STOCK 拒绝记录,重开后仍生效)
- 批次树:父批次发料按各节点 `max(0, onHand - reserved)` 比例消耗子批次(最大余数法分配,确定次序)
- 解码器增量维护层级库存与预留预算;`available(b) = 子树 onHand 合计 - 子树 reserved 合计`
- 保存点记录在快照清单 `manifest.json`(tmp + rename 原子替换;rename 前崩溃仍用上一清单)
- 回滚 = 追加反向补偿记录 + 回滚证书记录,旧账目不擦除
- 快照 `snapshots/snap-*.json` 记录状态与日志偏移,打开时从最近有效快照续放
- `Ledger.recover(dir)` 截断损坏尾部块并修复清单,保存点状态可回滚恢复

## 错误码

| 码 | 含义 | CLI 退出码 |
| --- | --- | --- |
| `E_STOCK` | 库存/预算不足 | 2 |
| `E_SAVEPOINT` | 保存点不存在 | 3 |
| `E_CRC` | 块损坏 | 4 |
| `E_VALID` | 参数非法 | 5 |

## CLI

```sh
node cli.js --dir ./ledger receive --batch A --qty 30 [--parent P] --key k1
node cli.js --dir ./ledger reserve --batch A --qty 10 --key k2
node cli.js --dir ./ledger issue  --batch P --qty 45 --key k3
node cli.js --dir ./ledger return --batch A --qty 5  --key k4
node cli.js --dir ./ledger savepoint --name S
node cli.js --dir ./ledger rollback --name S
node cli.js --dir ./ledger snapshot
node cli.js --dir ./ledger recover
node cli.js --dir ./ledger balance
node cli.js --dir ./ledger history
```

## 库用法

```js
import { Ledger } from './src/ledger.js';

const ledger = Ledger.open('./ledger');
ledger.execute('receive', { batch: 'A', qty: 30, parent: 'P' }, 'key-1');
ledger.savepoint('S');
ledger.execute('issue', { batch: 'P', qty: 10 }, 'key-2');
const certificate = ledger.rollback('S'); // 追加补偿记录,返回回滚证书
console.log(ledger.status());
```

## 测试

```sh
node --test
```
