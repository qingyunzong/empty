# 保理发票库（factoring-ledger）

Node.js 22 标准库实现，单机离线，无第三方依赖。

## 模型

- 发票：`{ id, creditor, faceValue, advanceRate, memo, state }`，`state ∈ active|revoked`
- 冻结额：`faceValue × advanceRate`（四舍五入到分），总额不得超过 `creditLimit`
- 关联簇：同一债权人下，两张发票 memo 存在共同词且最小词距 `≤ slop` 即关联；并查集传递成簇（≥2 张才成簇）
- 撤销：仅释放该发票冻结额，返回证书（含仍存活的关联成员）；簇成员不足 2 时物理删除位置条目并压缩索引
- 候选排序：词距升序 → 金额差升序 → id 升序

## 库 API（src/factoring.js）

```js
import { FactoringLedger } from './src/factoring.js';
const ledger = new FactoringLedger({ creditLimit: 100000, slop: 1 });
ledger.addInvoice({ id: 'A1', creditor: 'acme', faceValue: 10000, advanceRate: 0.8, memo: 'steel delivery' });
ledger.frozenTotal(); ledger.available();
ledger.clusters(); ledger.matchCandidates('A1');
const cert = ledger.revoke('A1'); // { revokedId, releasedAmount, clusterId, clusterDissolved, survivingMembers }
ledger.save('data.json');
const reopened = FactoringLedger.load('data.json');
```

错误均抛出 `FactoringError`，`code` 取值：`INVALID_RATE`、`INVALID_FACE_VALUE`、`INVALID_LIMIT`、`INVALID_SLOP`、`INVALID_ID`、`INVALID_CREDITOR`、`DUPLICATE_INVOICE`、`LIMIT_EXCEEDED`、`INVOICE_NOT_FOUND`、`ALREADY_REVOKED`。

## CLI

```sh
node cli.js add --file d.json --id A1 --creditor acme --face 10000 --rate 0.8 \
  --memo "steel delivery" --limit 100000 --slop 1   # --limit/--slop 仅建文件时需要
node cli.js revoke --file d.json --id A1
node cli.js status --file d.json
node cli.js clusters --file d.json
node cli.js candidates --file d.json --id A1
```

## 测试

```sh
node --test
```
