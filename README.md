# recon-minimize

金融对账差错定位库与 CLI。仅使用 Node.js 22 标准库，测试基于 `node:test`。

## 输入

`recon.json`：`{ "expected": [...], "actual": [...] }`，每条分录字段：

| 字段 | 说明 |
| --- | --- |
| `entryId` | 非空字符串，同一侧内唯一 |
| `account` | 非空字符串 |
| `amount` | 有限数值，必须 ≥ 0 |
| `type` | `normal` 或 `reversal` |
| `reversalOf` | 仅撤销分录携带，指向同侧某正常分录的 `entryId` |

## 对账语义

- 正常分录按 `(entryId, account, amount)` 在 expected 与 actual 之间一一匹配。
- 撤销分录必须与同侧原分录配对，且金额相等（效果相反：原分录 `+x`，撤销 `-x`）；配对成功两者在同侧抵消。
- 未匹配的原分录不能被其撤销单独抵消：另一侧只有撤销而没有原分录时，原分录计 `missing`，撤销计 `invalid-reversal`（孤立撤销）。
- 差异四类：
  - `missing`：expected 有、actual 无；
  - `extra`：actual 有、expected 无；
  - `amount-mismatch`：`entryId`+`account` 相同但金额不同；
  - `invalid-reversal`：`origin-missing` / `origin-already-reversed` / `amount-not-opposite`。
- `totals.netImpact` 为总量影响：actual 侧未匹配效果（撤销为负）减去 expected 侧未匹配效果，再加金额不符差额。

## 拒绝规则（退出码 1，`INVALID_RECON`）

- 金额为负或非有限数值；
- 同一侧内 `entryId` 重复；
- 非法撤销链：撤销指向自身或指向另一条撤销；
- 结构错误（缺字段、类型非法、文件不可读/非 JSON）。

## 最小化（可审计归约）

谓词：子集复现完整输入的差异签名（`canonicalStringify(differences)`）。

- 总条目 ≤ 8：`exhaustive-lexicographic`，按基数递增、同基数按字典序枚举子集
  （条目规范序：expected 在前，两侧各自按 `entryId` 排序），保证基数最小且字典序最小。
- 总条目 > 8：`greedy-one-minimal`，单条删除 + 伙伴对（跨侧匹配对、同侧撤销对）
  删除迭代至不动点，保证删除任意单条后差错消失（1-最小）。

## CLI

```sh
node src/cli.js minimize recon.json
```

输出 JSON：`status`（`BALANCED`/`UNBALANCED`）、`certificate`（算法与最小性保证）、
`differences`、`totals`、`minimal`（最小 expected/actual 子集）、`replayHash`
（对 `{differences, minimal, totals}` 的规范序列化做 SHA-256，可重放校验）。

退出码：平衡或不平衡均为 0；输入非法为 1（stderr 含 `INVALID_RECON`）；用法错误为 2。

## 库 API

```js
import { analyze, reconcile, minimize, validateRecon } from './src/recon.js';
```

## 测试

```sh
node --test 2>&1 | tee test-result.txt
```

其中对 ≤4 条输入用测试内独立实现的子集枚举器对照 `minimize` 的结果
（固定用例 + 300 例种子化模糊测试）。
