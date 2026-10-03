# factoring-invoice-store

单机离线保理发票库。Node.js 22 标准库实现，无第三方依赖。

## 模型

- 发票字段：`id`、`creditor`、`faceValue`、`advanceRate`、`memo`、`state`（`active` / `revoked`）。
- 每张活跃发票按 `faceValue × advanceRate` 冻结融资额度；`totals()` 返回
  `{ creditLine, frozen, available }`，逐张枚举活跃发票求和。
- **关联簇**：同一债权人下，两张发票的 memo 在指定 `slop` 内命中共同有序词对
  （两词之间间隔词数 ≤ slop，slop=0 即相邻二元组）即相关联；关联按传递闭包成簇。
- **撤销**：`revokeInvoice` 只释放该发票的冻结额，返回证书，证书列出簇内仍存活
  成员（直接相关者按 词距 → 金额差 → id 排序，仅传递相关者列后）；簇被清空时
  物理删除其位置条目并压缩槽位数组，持久化文件与重启后均无空簇残留。
- **候选排序**：`rankCandidates(id)` 按 词距升序 → 金额差升序 → id 升序。

## 库用法

```js
const { FactoringStore } = require('./src/store.js');

const store = new FactoringStore({ creditLine: 1_000_000, slop: 1, file: 'store.json' });
store.addInvoice({ id: 'inv1', creditor: 'acme', faceValue: 10000, advanceRate: 0.8, memo: 'steel delivery' });
store.totals();          // { creditLine, frozen, available }
store.clusters();        // [{ id, creditor, members }]
store.rankCandidates('inv1');
const cert = store.revokeInvoice('inv1'); // 证书含 survivingMembers / clusterRemoved
const again = FactoringStore.load('store.json'); // 重启恢复
```

错误均抛出 `FactoringError`，`code` 取值：`INVALID_ADVANCE_RATE`、
`INVALID_FACE_VALUE`、`INVALID_INVOICE_ID`、`INVALID_CREDITOR`、
`DUPLICATE_INVOICE_ID`、`CREDIT_LINE_EXCEEDED`、`INVOICE_NOT_FOUND`、
`INVOICE_ALREADY_REVOKED`、`INVALID_CREDIT_LINE`、`INVALID_SLOP`。

## CLI

```sh
node bin/cli.js init  --file s.json --credit-line 1000000 --slop 1
node bin/cli.js add   --file s.json --id inv1 --creditor acme --face-value 10000 --advance-rate 0.8 --memo "steel delivery"
node bin/cli.js totals --file s.json
node bin/cli.js clusters --file s.json
node bin/cli.js candidates --file s.json --id inv1
node bin/cli.js revoke --file s.json --id inv1
node bin/cli.js get --file s.json --id inv1
node bin/cli.js list --file s.json
```

stdout 输出 JSON；错误写 stderr 并以退出码 1 结束。

## 测试

```sh
node --test
```
