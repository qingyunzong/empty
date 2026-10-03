# txn-linearizability-checker

判断并发客户端的交易预留历史是否**可线性化**：是否存在一个操作顺序，
使所有 `reserve` / `commit` / `cancel` / `read` 看起来像顺序执行。
仅使用 Node.js 22 标准库与 `node:test`，无第三方依赖。

## 历史格式

JSON 数组，每个操作：

| 字段 | 说明 |
| --- | --- |
| `client` | 客户端标识（非空字符串） |
| `opId` | 操作标识，**全局唯一** |
| `invocationTime` / `responseTime` | 调用/响应时间（有限数值，`responseTime >= invocationTime`） |
| `type` | `reserve` \| `commit` \| `cancel` \| `read` |
| `account` | 账户（非空字符串） |
| `amount` | 金额，`reserve` 必填，其余可选；必须 `>= 0` |
| `reserveId` | `reserve`/`commit`/`cancel` 必填 |
| `status` | `reserve`/`commit`/`cancel` 的响应：`"ok"`（默认）或 `"fail"` |
| `balance` / `frozen` | `read` 必填：读到的可用余额与冻结额 |

## 语义（顺序规约）

- 线性化点落在 `[invocationTime, responseTime]` 内；若 A 的响应不晚于 B 的调用，则 A 必须先于 B（实时先后）。
- `reserve`：余额充足且 `reserveId` 未使用时成功，`balance -= amount`、`frozen += amount`，持有该预留；否则 `fail`。
- `commit`：仅对 `held` 状态的预留成功一次，释放持有（`frozen -= amount`，资金划出账户）；重复 commit 必为 `fail`。
- `cancel`：仅能撤销未成交（`held`）的预留，`frozen -= amount`、`balance += amount`；否则 `fail`。
- `read`：读到某个合法线性化点上该账户的 `(balance, frozen)`。

## 明确定义的边界情况

- **零金额**：`reserve(0)` 总是成功且不冻结任何额度；其 commit/cancel 行为与正常预留一致。
- **未知 reserveId**：`commit`/`cancel` 引用未知或已终结的 `reserveId` 是**失败操作**（`status:"fail"`），不是非法历史；若历史记录它为 `ok` 则该历史不可线性化。
- **重复响应**：相同 `opId` 出现两次视为重复响应，整个历史判为 `INVALID_HISTORY`（退出码 1）。
- **负金额 / 时间倒置（responseTime < invocationTime）/ 结构非法**：`INVALID_HISTORY`，退出码 1。

## CLI

```sh
node cli.js check history.json [--initial-balance N]
```

- `--initial-balance N`：每个账户的初始余额（默认 0）。
- 退出码 `0`：历史格式合法。stdout 输出
  `{"linearizable":true,"witness":[{opId,...,linearizationPoint}...],"order":[...]}`
  或 `{"linearizable":false,"reason":"..."}`。
- 退出码 `1`：`INVALID_HISTORY: <原因>` 打到 stderr。
- 退出码 `2`：CLI 用法错误。

```sh
node cli.js check examples/overlapping-reads.json --initial-balance 100
node cli.js check examples/cancel-then-commit.json --initial-balance 100
node cli.js check examples/invalid-negative.json   # exit 1
```

## 库

```js
import { checkLinearizability } from './src/checker.js';
const result = checkLinearizability(history, { initialBalance: 100 });
```

- `src/model.js`：历史校验 + 顺序状态机。
- `src/checker.js`：主检查器——实时偏序上的 DFS + `(已放置集合, 状态)` 记忆化，产出见证顺序与线性化点。
- `src/brute.js`：独立的全排列枚举器（自带小型解释器），用于对照测试。
- `src/cliMain.js`：纯函数式 CLI 核心（返回 `{code, stdout, stderr}`），`cli.js` 仅做进程包装。

## 测试

```sh
node --test
```

`test/brute.test.js` 对 ≤6 个操作的历史（400 组带种子的随机用例 + 手工用例）
将主检查器与独立全排列枚举器逐一比对，并回放见证验证其合法性。
