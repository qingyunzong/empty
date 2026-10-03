# chargeback-evidence-store

支付拒付案件的证据检索库。纯 Node.js 22 标准库实现，单机离线，无第三方依赖。

## 数据模型

- 证据：`{ id, caseId, amount, text, revision }`，追加式存储，绝不覆盖。
- 更正：`correctEvidence` 追加 `revision + 1` 的新版本；显式指定的 revision 不等于下一序号即判为倒挂（`REVISION_REGRESSION`）。
- 撤销：`revokeRevision` 标记该 revision 已撤销并追加墓碑记录，墓碑携带冲正金额（`-amount`）；旧 revision 仍可按历史版本查询。
- 当前视图：每条证据取最新未撤销 revision；全部撤销则退出当前视图。

## 查询

- 短语查询：词项严格连续匹配，命中按证据 id 升序、起始位置升序排列。
- 无序近邻查询：词项任意顺序落在同一窗口内，窗口跨度 `hi - lo <= (去重词数 - 1) + slop`；
  每条证据取最小窗口，命中按词距升序、证据 id 升序排列（并列顺序确定）。
- 证书 `getCertificate(caseId, query)`：包含案件、revision（案件记录集最大版本号）、
  命中位置、当前金额、冲正金额与记录集哈希（SHA-256）。

## 库 API

```js
import { EvidenceStore } from './src/store.js';

const store = new EvidenceStore();
store.addEvidence({ id: 'E1', caseId: 'C1', amount: 100, text: 'stolen card used at hotel' });
store.correctEvidence('E1', { text: 'cardholder verified the stay', revision: 2 });
store.revokeRevision('E1', 2);                       // -> tombstone, reversalAmount: -100
store.queryCurrent('C1', { phrase: 'stolen card' });
store.queryCurrent('C1', { near: 'card hotel', slop: 2 });
store.queryAtRevision('C1', 1, { phrase: 'stolen card' }); // 历史版本
store.getCertificate('C1', { near: 'card hotel', slop: 2 });
```

错误均以 `StoreError` 抛出（`code` 为 `UNKNOWN_CASE` / `UNKNOWN_EVIDENCE` /
`UNKNOWN_REVISION` / `REVISION_REGRESSION` / `ALREADY_REVOKED` / `DUPLICATE_EVIDENCE`），
出错时不产生任何新写入。

## CLI

状态保存在 JSON 文件中（`--db`）：

```sh
node bin/evidence.js add         --db f.json --id E1 --case C1 --amount 100 --text "stolen card"
node bin/evidence.js correct     --db f.json --id E1 --text "new wording" --revision 2
node bin/evidence.js revoke      --db f.json --id E1 --revision 2
node bin/evidence.js query       --db f.json --case C1 --phrase "stolen card"
node bin/evidence.js query       --db f.json --case C1 --near "card hotel" --slop 2
node bin/evidence.js query       --db f.json --case C1 --phrase "stolen card" --at-revision 1
node bin/evidence.js certificate --db f.json --case C1 --near "card hotel" --slop 2
node bin/evidence.js amount      --db f.json --case C1
```

成功时向 stdout 输出 JSON、退出码 0；失败时向 stderr 输出
`{"error": CODE, "message": ...}`、退出码 1，且不写库文件。

## 测试

```sh
node --test
```
