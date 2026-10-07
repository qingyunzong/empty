# payment-ledger

单机离线支付账本库与 CLI（Node.js 22，仅标准库）。账户持有**可用余额**与**冻结额度**，
支持授权（冻结）、确认、扣款、撤销/部分撤销（撤销链）、超时到期。并发请求按
**逻辑时钟 + clientOpId** 线性化，重复提交幂等，任意重放得到同一终态，并输出可验证哈希链。

## 操作类型

| type        | 字段                              | 语义 |
|-------------|-----------------------------------|------|
| `deposit`   | `amount`                          | 充值，可用余额 += amount |
| `authorize` | `amount`, `ttl?`                  | 冻结：available→frozen，创建 PENDING 持有（hold），`timeoutSlot = clock + ttl`（默认 10） |
| `confirm`   | `parent`                          | PENDING → CONFIRMED（已确认） |
| `capture`   | `parent`, `amount`                | 扣款：frozen 减少，资金离账（captured），可部分扣款 |
| `void`      | `parent`, `amount?`               | 撤销：frozen→available；省略 amount 为全额撤销；部分撤销构成撤销链 |
| `expire`    | `parent`, `slot`, `outcome?`      | 超时槽到期后将 PENDING/CONFIRMED 持有转为 `EXPIRED`（默认）或 `FAILED`，释放冻结 |

每个操作携带 `clientOpId`（客户端幂等键）与 `clock`（Lamport 逻辑时钟）。
`parent` 指向祖先操作的 `clientOpId`（持有 id 即其 authorize 的 clientOpId）。

## 核心机制

- **冻结/解冻状态机**：`PENDING → CONFIRMED → CLOSED | VOIDED | EXPIRED | FAILED`。
  PENDING 不视为不可满足：只能由 `expire` 在 `slot >= timeoutSlot` 后明确转为
  `EXPIRED` 或 `FAILED`（`slot` 不足时报 `TIME_TRAVEL`）。
- **撤销链（增量更正）**：`void`/`capture` 只能针对**已确认**祖先（PENDING/EXPIRED/FAILED
  报 `BAD_PARENT`）；部分撤销累计不得超过原额（超出报 `FROZEN`）；对已 VOIDED 的持有
  再次撤销返回 `IDEMPOTENT`；剩余冻结归零时按撤销/扣款构成转为 `VOIDED` 或 `CLOSED`。
- **并发历史线性化**：所有已提交操作按 `(clock, clientOpId, 规范化载荷)` 全序排序后重放，
  与到达顺序无关，任何重放得到同一终态与同一哈希链头。
- **幂等**：完全相同的操作重复提交返回缓存结果（`dedup: true`）且状态不变；
  同一 `clientOpId` 不同载荷按规范序取先者，其余报 `DUP_OP`。
- **哈希链**：`hash_i = sha256(hash_{i-1} || canonical(op) || canonical(result))`，
  创世哈希为 `sha256("payment-ledger-v1-genesis")`；`verifyLog(log)` 可独立验证。

## 错误码

| 码            | 含义 |
|---------------|------|
| `INSUFFICIENT`| 授权金额超过可用余额 |
| `FROZEN`      | 扣款/撤销金额超过持有剩余冻结额（含部分撤销累计超原额） |
| `BAD_PARENT`  | 祖先不存在，或祖先未确认（PENDING/EXPIRED/FAILED） |
| `DUP_OP`      | 同一 clientOpId 提交了不同载荷 |
| `TIME_TRAVEL` | 子操作 clock 不大于祖先 clock，或 expire 的 slot 早于 timeoutSlot |

## CLI

```sh
# 从 stdin 读操作数组（或 {"ops":[...]}），向 stdout 输出 JSON
echo '[{"clientOpId":"d1","clock":1,"type":"deposit","amount":100},
       {"clientOpId":"a1","clock":2,"type":"authorize","amount":60}]' | node src/cli.js

# 可选 --state <path>：持久化已提交操作（写临时文件后原子 rename），
# 下次运行自动重放历史；任何失败（非法 JSON、非法操作）都不会部分落盘，
# stdout 无输出，错误 JSON 写 stderr，退出码 1。
node src/cli.js --state ledger.json < ops.json
```

输出：`{ ok, view, results, log, head }` —— 账户视图、逐操作结果、操作流水（含每环哈希）、链头。

## 库 API

```js
import { Ledger, verifyLog } from './src/engine.js';
const ledger = new Ledger();
ledger.submit(op);        // 单个提交，返回 {status, error?}；重复提交返回 {..., dedup: true}
ledger.submitAll(ops);    // 批量提交，按输入顺序返回结果数组
ledger.view;              // { available, frozen, captured, holds: [...] }
ledger.log;               // [{ op, result, hash }] 操作流水/哈希链
ledger.head;              // 链头哈希
verifyLog(ledger.log);    // 独立验证哈希链
```

## 测试

```sh
node --test
```

- `test/engine.test.js`：状态机、撤销链、幂等、错误码、乱序线性化、哈希链篡改检测。
- `test/cli.test.js`：stdin/stdout 协议、原子失败、状态文件重放一致。
- `test/enumeration.test.js`：对 n=1..9 的操作集，枚举**全部** n! 种到达顺序，
  与测试内独立实现的状态机逐一对照终态视图与哈希链头（n=9 为 362880 种排列）。
