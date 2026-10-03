# 拒付证据检索库（chargeback evidence store）

纯 Node.js 22 标准库实现，单机离线，无第三方依赖。为支付拒付案件建立证据检索库：
证据含 `id`、`caseId`、`amount`、`text`、`revision`，对 `text` 建位置索引，支持短语与无序近邻查询。

## 数据模型

- 只追加日志：`case` / `evidence` / `tombstone` 三类记录，任何更正都不覆盖旧数据。
- 更正 = 同一 `id` 写入 `revision + 1` 的新证据；revision 倒挂（`<=` 当前最大）或跳号直接报错。
- 撤销 = 追加墓碑记录，携带冲正金额（`reversalAmount = -amount`）；旧 revision 仍可按历史版本查询。
- 当前视图 = 每条证据的最新未撤销 revision；历史视图 = `revision <= N` 的最大 revision（无视墓碑）。

## 查询

- `phrase`：词项连续出现。
- `near`（`slop`）：枚举所有无序窗口（每个词项各取一个出现位置），窗口跨度
  `max - min - (n - 1) <= slop` 即命中。命中按词距升序、证据 id 升序、窗口起点升序排列，顺序确定。

## 证书

`issueCertificate` 输出：案件号、revision、查询、命中（含位置）、当前金额、冲正金额、
记录集哈希（sha256，对案件全部记录做规范化序列化后计算）。

## 库 API（`src/store.js` / `src/index.js` / `src/certificate.js`）

```js
import { createStore, registerCase, addEvidence, revokeRevision, search, caseAmounts } from './src/store.js';
import { issueCertificate } from './src/certificate.js';

const store = createStore();
registerCase(store, 'CB-1');
addEvidence(store, { id: 'ev-1', caseId: 'CB-1', amount: 100, text: 'merchant promised refund', revision: 1 });
addEvidence(store, { id: 'ev-1', caseId: 'CB-1', amount: 130, text: 'issuer confirmed chargeback', revision: 2 });
search(store, 'CB-1', { type: 'near', terms: ['confirmed', 'chargeback'], slop: 2 });
search(store, 'CB-1', { type: 'phrase', terms: ['promised', 'refund'] }, { revision: 1 }); // 历史查询
revokeRevision(store, 'CB-1', 'ev-1', 2);          // 墓碑 + 冲正 -130
caseAmounts(store, 'CB-1');                        // { currentAmount: 100, reversalAmount: -130 }
issueCertificate(store, 'CB-1', { type: 'phrase', terms: ['chargeback'] });
```

## CLI（`src/cli.js`，状态存于 JSONL 只追加日志）

```sh
node src/cli.js --store s.jsonl case:create CB-1
node src/cli.js --store s.jsonl add CB-1 ev-1 100 1 "merchant promised refund"
node src/cli.js --store s.jsonl add CB-1 ev-1 130 2 "issuer confirmed chargeback"
node src/cli.js --store s.jsonl search CB-1 --near confirmed chargeback --slop 2
node src/cli.js --store s.jsonl search CB-1 --phrase promised refund --revision 1
node src/cli.js --store s.jsonl cert CB-1 --phrase chargeback
node src/cli.js --store s.jsonl revoke CB-1 ev-1 2
node src/cli.js --store s.jsonl amounts CB-1
```

错误（未知案件 `ERR_UNKNOWN_CASE`、revision 倒挂 `ERR_REVISION_REGRESSION`、
重复撤销 `ERR_ALREADY_REVOKED` 等）以退出码 1 返回，且不会向日志追加任何记录。

## 测试

```sh
node --test
```

包含：短语/近邻与"枚举所有无序窗口"参考实现的随机化对照（300 例）、命中排序确定性、
更正/撤销/历史查询、错误无写入、证书字段与哈希、CLI 端到端。
