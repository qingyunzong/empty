# riskctl — 并发额度风控判定（冻结 / 解冻 / 扣款）

Node.js 22，仅标准库，离线单机。库 + CLI 判定最终可用额度并解释冲突。

## 模型

- 账户有**总限额** `totalLimit` 与**分类限额** `categoryLimits: {scope: limit}`，均为正整数（最小货币单位）。
- **冻结** 是额度轴 `[0, totalLimit]` 上的区间 `[start, end]`；重叠或相邻的冻结自动合并。
- **解冻** 只能切割已有冻结；解冻区间不与任何冻结相交时失败（`E_RANGE`），无副作用。
- **扣款** 检查优先级：显式冻结 > 分类限额 > 总限额。
  - `amount > totalLimit - frozenTotal - debitedTotal` 时：若去掉冻结本可通过 → `E_RANGE`（被显式冻结阻断）；否则 → `E_LIMIT`（总限额）。
  - 分类限额不足 → `E_LIMIT`（分类）。
- **同刻请求** 按 `id` 字典序处理（`ts` 相同、`id` 也相同则按文件先后）；所有请求按 `(ts, id)` 排序后依次应用，与文件顺序无关。
- **失败请求无副作用**，但写入审计链。重复 `id` → `E_DUP`（首次出现的请求生效，无论其成败）。

## 输入（JSONL）

首行必须是配置记录，其余每行一个请求：

```json
{"op":"config","totalLimit":1000,"categoryLimits":{"travel":300}}
{"ts":1,"id":"f1","op":"freeze","start":100,"end":300}
{"ts":2,"id":"u1","op":"unfreeze","start":150,"end":250}
{"ts":3,"id":"d1","op":"debit","amount":200,"scope":"travel"}
```

- `freeze` / `unfreeze`：区间用 `start` / `end` 字段（也接受 `amount: {"start":s,"end":e}`）。
- `debit`：`amount` 为正整数，`scope` 为分类名（缺省 `"default"`，无分类限额时只受总限额约束）。

## 输出（report.json）

- `steps[]`：每步 `seq, ts, id, op, ok, reason, detail, available, frozen, hash`。
- `final`：`available, frozen, frozenTotal, debitedTotal, debitedByScope`。
- `audit[]`：每步一条审计记录，`prevHash` 链接上一条（首条为 64 个 `0`），`hash = sha256({seq,ts,id,op,ok,reason,detail,prevHash,stateDigest})`，`stateDigest` 绑定该步之后的状态，篡改可检测。

## 错误约定

| 码 | 含义 |
|---|---|
| `E_RANGE` | 区间/金额非法、解冻无交集、扣款被显式冻结阻断、输入格式错误 |
| `E_LIMIT` | 分类限额或总限额不足 |
| `E_DUP` | 重复请求 id |

CLI：任何一步失败 → 失败详情写 **stderr** 且**退出码 1**（report.json 照常写出）；全部成功退出码 0。输入级错误（坏 JSON、缺配置行）→ `E_RANGE` + stderr + 退出码 1，不写报告。

## 使用

```sh
node cli.js ops.jsonl report.json   # CLI
node --test                          # 全部测试
```

库：

```js
const { Account } = require('./lib/account');
const account = new Account({ totalLimit: 1000, categoryLimits: { travel: 300 } });
const report = account.applyAll(ops); // ops 自动按 (ts, id) 排序
```

## 文件

- `lib/account.js` — 区间合并/切割、限额判定、审计链
- `cli.js` — JSONL → report.json，`run(argv, io)` 可进程内调用
- `test/` — 冻结合并/切割、限额优先级、同刻并发、随机 100 步对拍（`test/helpers/brute.js` 为按位暴力参照模型）、CLI
- `examples/ops.jsonl` — 示例输入
