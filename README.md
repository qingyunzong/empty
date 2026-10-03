# pay-ledger

单机离线支付账本库与 CLI（Node.js 22，仅标准库）。账户持有**可用余额**与**冻结额度**，
支持授权（冻结）、扣款（捕获）、撤销 / 部分撤销（形成撤销链）、过期处理。
并发请求以**逻辑时钟 + clientOpId** 线性化判定历史，重复提交幂等，输出可验证哈希链，
任意重放得到同一终态。

## 操作模型

每个操作携带 `clientOpId`（幂等键）与 `clock`（逻辑时钟）：

| type        | 字段                          | 语义 |
|-------------|-------------------------------|------|
| `deposit`   | `amount`                      | 充值到可用余额 |
| `authorize` | `amount`, `ttl?`              | 从可用余额冻结，`expiresAt = clock + ttl`（默认 10） |
| `capture`   | `parentId`, `amount`          | 从已确认授权扣款（可部分），冻结转出系统 |
| `reverse`   | `parentId`, `amount?`         | 撤销已确认祖先（授权=解冻回可用，扣款=退款回可用）；缺省 amount 为全额；`parentId` 可指向原始操作或链上任意前序撤销，累计不得超过原额 |
| `expire`    | `parentId`                    | 超时槽到期后将 PENDING 授权明确转为 `EXPIRED` 并解冻 |

### 授权状态机

`PENDING → CAPTURED | REVERSED | EXPIRED | FAILED`

- `PENDING` 不等于不可满足：到期前 `expire` 返回 `{status:"PENDING"}`，不做任何变更；
  到期后由 `expire` 明确转为 `EXPIRED`。
- 过期后的迟到 `capture` / `reverse` 使授权转为 `FAILED`（释放剩余冻结），操作本身报 `FROZEN`。
- 撤销已完全撤销的对象返回 `IDEMPOTENT`，不产生副作用。

### 线性化与幂等

- 历史按 `(clock, clientOpId)` 排序后重放，与到达顺序无关 → 乱序并发得到同一终态、同一 tip hash。
- 同一 `clientOpId` 相同负载重提交 → 返回首次结果（`replay: true`）；负载冲突 → `DUP_OP`。
- 子操作时钟早于其父 → `TIME_TRAVEL`；父未知 / 未确认 → `BAD_PARENT`。

### 错误码

`INSUFFICIENT`（余额/额度不足或部分撤销累计超额）、`FROZEN`（作用于已过期/已失效授权）、
`BAD_PARENT`、`DUP_OP`、`TIME_TRAVEL`。失败操作不改变任何状态。

### 哈希链

每条日志项：`hash = sha256(prevHash | stable(op) | stable(result) | stateDigest)`，
`prevHash` 起始于 `genesisHash(initialBalance)`。`verifyHashChain(log, initialBalance)` 可独立验证。

## CLI

从 stdin 读操作数组（或 `{"initialBalance": n, "ops": [...]}`），向 stdout 输出 JSON
（`view` / `results` / `log` / `tipHash`）。`--out <file>` 以临时文件 + rename 原子落盘；
任何输入非法时退出码 1，stdout 与目标文件均无部分输出。

```sh
echo '[{"type":"deposit","clientOpId":"d1","clock":1,"amount":500},
       {"type":"authorize","clientOpId":"a1","clock":2,"amount":200,"ttl":5},
       {"type":"capture","clientOpId":"c1","clock":3,"parentId":"a1","amount":120},
       {"type":"reverse","clientOpId":"r1","clock":4,"parentId":"c1","amount":50}]' \
  | node bin/cli.js
```

## 库

```js
import { Engine, verifyHashChain } from './src/engine.js';
const eng = new Engine({ initialBalance: 0 });
eng.submit({ type: 'deposit', clientOpId: 'd1', clock: 1, amount: 100 });
eng.view();      // 账户视图
eng.log;         // 操作流水（含哈希链）
eng.tipHash;     // 链尖
```

## 测试

```sh
node --test
```

- `test/engine.test.js`：超额冻结失败、部分撤销链恢复、乱序并发按逻辑时钟重放一致、
  幂等 / DUP_OP / TIME_TRAVEL / BAD_PARENT / FROZEN、expire 的 PENDING→EXPIRED/FAILED、哈希链验证与重放。
- `test/enumeration.test.js`：n ≤ 9 的全部 349 524 条操作序列与独立参考状态机
  （`test-helpers/ref-model.js`）逐操作对照；另有 20 000 条种子随机序列（含 expire/短 ttl/撤销链）
  与 200 组乱序重放一致性检查。
- `test/cli.test.js`：CLI 正常输出、失败原子性（不部分落盘）、`--out` 原子写。

最近一次真实运行（Node v22.22.1）：`node --test` → `# tests 3 / # pass 3 / # fail 0`，
总耗时约 80s（n≤9 枚举差分测试占绝大部分）。
