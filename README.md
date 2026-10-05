# recon-diff

对账差异定位库与 CLI。左右两本账各为事件流（JSONL），基于自动机的平衡语义判定联合可接受性；不可接受时求最小修正脚本，并产出可独立验证的差异证书。

- 运行时：Node.js 22，仅标准库，测试用 `node:test`，单机离线。
- 规模限制：每本账最多 200 事件（超出报 `INPUT_TOO_LARGE`）。

## 事件模型

```json
{"id":"l1","account":"cash","amount":100,"direction":"debit","currency":"USD","relId":"t1"}
```

- `id`：账本内唯一（重复报 `DUP_ID`）。
- `amount`：正有限数；内部以 1e-6 最小单位整数运算。
- `direction`：`debit` | `credit`。
- `relId`：关联号；同一关联号只允许单一币种（混币报 `CURRENCY_MIX`）。

## 平衡语义（自动机）

- `LedgerAutomaton`（`src/automaton.js`）：同账户事件构成因果链，必须按流序消费；不同账户可任意交错。状态 = 各链消费位置 + 按 `(relId, currency)` 的净额映射。全部消费且所有净额为 0 时接受（同关联号借贷配对 ⟹ 按币种总额为零）。
- `ProductAutomaton`：联合状态额外携带 exposure 多重集（左已消费未匹配 − 右已消费未匹配的规范形）。联合接受 ⟺ 两分量各自接受且 exposure 为空，即两本账规范形（账户|金额|方向|币种|关联号）多重集相同且各自内部平衡。快速判定用多重集比较（与乘积自动机 BFS 在小样本上交叉验证，见测试 D）。

## 修正脚本

操作（各代价 1）：

- `removeExtra {side, id}`：删除盈余事件。
- `addMissing {side, event}`：补录缺失事件。
- `relink {side, id, toRelId}`：把事件的关联号改指到另一关联号。

最小代价求解（`src/diff.js`）：

1. **组合快速通道**：每个操作至多消除对称差中 1 个左盈余 + 1 个右盈余，仅相容 relink 可各消一个，故 `|lOnly| + |rOnly| - p`（p = 最大 relink 匹配）是可证下界。规范基础脚本若直达联合平衡，则该下界即精确最小代价；全部并列最优脚本按操作的对称变体（relink 左/右、removeExtra/addMissing）组合枚举并按目标过滤。
2. **有界 BFS 回退**：对称差为空但内部失衡（或规范脚本后仍有残余失衡）时，在 `(左, 右)` 状态对上做代价分层 BFS（相关性剪枝 + 节点预算），枚举全部并列最优脚本。

输出最多 20 条并列最优脚本（`scriptCount` 保留完整计数）。超过界 `--k` 或节点预算时报 `SEARCH_BOUND`，**绝不**把受限搜索当作无差异：`balanced` 恒为 `false`，证书携带已证下界（组合下界，或搜索穷尽时的 `k+1`）。

## 差异证书

`certificate`（`src/certificate.js`）包含：

- `leftPrefix` / `rightPrefix`：把乘积自动机驱入拒绝状态的双方流前缀；
- `productState`：前缀重放后的净额与 exposure 摘要；
- 拒绝证明（验证器重算）：exposure 中存在对方剩余流无法抵消的规范形，或某 `(relId, currency)` 组已封闭（关联号不再出现）且净额非零；
- `continuation`：可选续接（一条最小修复脚本，验证器会实际应用并检查达到联合平衡）；
- `provenLowerBound`：`SEARCH_BOUND` 时的已证下界。

`verifyCertificate(left, right, cert)` 重放并校验全部声明，任何篡改抛 `CERT_INVALID`。

## 错误码

| 码 | 含义 |
| --- | --- |
| `DUP_ID` | 同一账本内事件 id 重复 |
| `CURRENCY_MIX` | 同一关联号混用币种 |
| `SEARCH_BOUND` | 最小代价超过 k 或搜索预算耗尽（附已证下界） |
| `CERT_INVALID` | 证书校验失败 |
| `INPUT_INVALID` / `INPUT_TOO_LARGE` | 输入非法 / 超过每本 200 事件 |

## CLI

```bash
node cli.js diff left.jsonl right.jsonl --k 5     # 输出 {balanced, scripts, certificate, error}
node cli.js verify left.jsonl right.jsonl cert.json
```

退出码：0 平衡/证书有效；1 有差异且有修复脚本；2 错误（含 `SEARCH_BOUND`、`CERT_INVALID` 等）。

库用法：

```js
import { diffLedgers, verifyCertificate } from './src/index.js';
const res = diffLedgers(leftEvents, rightEvents, { k: 5 });
```

## 测试

```bash
node --test
```

验收覆盖：A 完全平衡；B 单边多账 → `removeExtra`；C 关联号错配 → `relink`；D ≤8 事件、2 账户、2 币种的 3258 对小账本枚举，与独立暴力 oracle 对照最小代价并抽查乘积自动机；E 超过 K=5 报 `SEARCH_BOUND` 且证书给出已证下界。真实运行结果见 `RESULTS.md`。
