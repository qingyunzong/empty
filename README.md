# batch-trace

离散制造批次质量追溯库与 CLI（Node.js 22，零依赖，单机离线）。
所有数量以 BigInt 分数精确累计，无任何浮点误差。

## 概念

- `create(id, qty)`：建立根批次。
- `split(id, [{id, ratio}...])`：按比例拆分，比例和必须**恰为 1**，否则 `E_RATIONAL`。
- `join(inputs, output, loss)`：合并，输出 = 输入和 × (1 − 损耗率)，损耗率 ∈ [0, 1]。
- `quarantine(id)`：隔离批次。
- 事务：`transact(fn)` 内可增量提交多个操作，任一步失败整批回滚，库存不变。
- `undo()` / `redo()`：按事务粒度撤销/重做；新事务会清空 redo 栈。
- 查询：`ancestors` / `descendants` / `paths`（每条路径的累计有理比例）/
  `pathsBetween` / `pollutes`（污染证书：路径 + 累计比例）/ `quantity(id, decimals)`
  （精确分数 + 指定小数位舍入值 + 误差，误差 ≤ 半个单位）。
- 错误码：`E_RATIONAL`（非法比例/数量）、`E_CYCLE`（循环族谱）、
  `E_NOTFOUND`、`E_STATE`。

## 库用法

```js
const { Ledger } = require('./src/ledger');
const L = new Ledger();
L.create('root', 840);
L.split('root', [{ id: 'a', ratio: '1/2' }, { id: 'b', ratio: '1/3' }, { id: 'c', ratio: '1/6' }]);
L.quarantine('b');
L.join(['b', 'c'], 'out', '1/4');
L.pollutes('b', 'out');       // { polluted: true, certificate: { path: ['b','out'], ratio: 3/4 } }
L.quantity('out', 4);         // { exact: '315', decimal: '315.0000', error: '0', bound: '1/20000', ... }
L.undo();                     // 撤销 join，污染证书消失
```

## CLI

状态持久化在 `./trace-state.json`（可用 `TRACE_STATE` 覆盖）。

```
node cli.js create <id> <qty>
node cli.js split <id> <child:ratio>...
node cli.js join <output> <loss> <input>...
node cli.js quarantine <id>
node cli.js undo | redo
node cli.js inventory
node cli.js ancestors <id> | descendants <id> | paths <id>
node cli.js pollutes <quarantinedId> <outputId>
node cli.js quantity <id> [decimals]
```

成功退出码 0；业务错误打印 `E_*: message` 并退出码 1。

## 测试

```
node --test
```
