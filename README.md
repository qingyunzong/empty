# ledger-recon

对账差异定位库与 CLI。左右两本账为事件流，事件形如：

```json
{"id":"e1","account":"A1","amount":100,"direction":"debit","currency":"USD","rel":"r1"}
```

字段：`id`（账内唯一）、`account`、`amount`（建议用最小货币单位的整数）、
`direction`（`debit`/`credit`）、`currency`、`rel`（关联号）。每本账最多 200 事件。

## 平衡语义（自动机）

每本账编译为一个自动机：状态是各账户链的消费进度向量，字母表是账内事件，
接受语言 = 保持同账户因果序的重排中、局部平衡的序列（同关联号借贷配对、
总额按币种为零）。乘积自动机判定两本账是否联合可接受。

`src/automaton.js` 同时给出：

- `productExplore(L, R)`：显式惰性乘积自动机 BFS（小账本、测试 D 对照用）；
- `jointAcceptable(L, R)`：已证明等价的空性判据（同内容多重集 + 同账户序 +
  各关联号平衡），作为可扩展到 200 事件的决策过程。两者在枚举测试中互相对照。

## 最小修正脚本

不可接受时按代价分层 BFS，操作仅三种、代价各 1：

- `addMissing`（从另一本账复制缺失事件，追加到账尾）
- `removeExtra`（删除多余事件）
- `relink`（修改事件的关联号）

输出全部并列最优脚本，最多 20 条（超出时 `scriptsTruncated: true`，绝不静默截断）。
超过界 `--k` 时报 `SEARCH_BOUND`，且证书载明已证下界（`provenLowerBound`），
绝不把搜索超界当作无差异。

## 差异证书

- `accept`：公共线性化 witness，可重放验证；
- `reject`：到达拒绝状态的双方前缀 + 可选续接（剩余后缀）+ 分歧细节；
- `search-bound`：`k`、`provenLowerBound` 与内嵌 reject 证书。

`verifyCertificate(left, right, cert)` 独立重算并比对，任何不符抛 `CERT_INVALID`。

## 错误码

`DUP_ID`（账内 id 重复）、`CURRENCY_MIX`（同一关联号混币种）、
`SEARCH_BOUND`（最小代价超过 k）、`CERT_INVALID`（证书验证失败）。

## 用法

```sh
node cli.js diff   left.jsonl right.jsonl --k 5
node cli.js verify left.jsonl right.jsonl certificate.json
node --test
```

库 API（`index.js`）：`diffBooks(left, right, {k})` →
`{balanced, scripts, scriptsTruncated, certificate, error?}`；
`verifyCertificate(left, right, cert)`；`productExplore`；`jointAcceptable`；
`minRepairScripts`；`applyScript`。

CLI 退出码：balanced=0，未平衡/SEARCH_BOUND=1，输入错误=2，CERT_INVALID=3。
