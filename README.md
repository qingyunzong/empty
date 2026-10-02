# settlement-migrate

监管报送前，把旧结算指令集迁移到新格式，并生成可独立验证的等价性证明（proof），
证明每个账户的最终余额（`debit - credit`）与冻结（`freeze`）关系等价。

运行环境：Node.js 22，仅标准库，无第三方依赖，单机离线。

## 用法

```sh
node cli.js migrate <old.json> <patch.json> --out <new.json> --proof <proof.json>
node cli.js verify  <old.json> <new.json> <proof.json>
```

（`package.json` 也注册了 bin 名 `settlement-migrate`。）

## 数据格式

指令（instruction）：

```json
{ "id": "i1", "account": "A", "currency": "USD",
  "debit": 100, "credit": 40, "freeze": 10,
  "state": "PENDING", "memo": "optional" }
```

- `debit` / `credit` / `freeze` 必须是非负安全整数（最小货币单位）。
- `state` 为字符串；`SETTLED` 受到特殊保护（见下）。
- 输入文件可以是指令数组，或 `{ "instructions": [...] }`。

patch 文件为 `{ "ops": [...] }`（或裸数组），支持三种操作：

| op | 形式 | 规则 |
| --- | --- | --- |
| `split` | `{ "op": "split", "id": "i1", "parts": [...] }` | 每个 part 可省略 `account/currency/state/memo`（继承原指令），金额省略为 0；按账户守恒 |
| `merge` | `{ "op": "merge", "ids": ["a","b"], "newId": "m1" }` | 所有 ids 必须同账户同币种；金额为求和；state 全同则保留，否则 `PENDING` |
| `restate` | `{ "op": "restate", "id": "i1", "fields": {...} }` | 可改 `debit/credit/freeze/state/memo/account/currency`；`SETTLED` 指令只能改 `memo` |

## proof 与不变量

`migrate` 生成的 proof 包含：

- `perAccountDelta`：旧表 → 新表按账户的 `{net, freeze}` 差值（零差值账户省略）。
- `conservation`：每个 split/merge op 的按账户贡献（必须全部为零，`ok: true`）。
- `forbiddenOps`：禁止操作列表；合法迁移恒为空数组。
- `ops`：每个已应用 op 的输入/输出快照与按账户贡献，供 verify 重放。

`verify` 不读取 patch，而是从 old/new/proof 独立重算，按顺序检查三个不变量，
并在失败时输出**第一个**失败的不变量（exit 1）：

1. `perAccountDelta` — 重算 old→new 的按账户差值，与 proof 声明比对。
2. `conservation` — 从旧表重放 `proof.ops`：输入快照必须匹配当前表状态，
   重放结果必须精确复现新表；split/merge 的重算贡献必须为零；
   所有 op 的贡献之和必须等于 perAccountDelta；`conservation` 段必须与重算一致。
3. `forbiddenOps` — proof 列表必须为空；旧表中存续的 `SETTLED` 指令金额与状态不得改变；
   被 split/merge 消耗的 `SETTLED` 指令金额必须守恒；对 `SETTLED` 的 restate 只能改 `memo`。

成功时输出 `OK: all invariants hold (...)`，exit 0。

## 退出码

| code | 含义 |
| --- | --- |
| 0 | 成功 |
| 1 | verify 不变量失败（输出首个失败的不变量） |
| 2 | 用法 / 输入格式错误 |
| 25 | split/merge 破坏按账户守恒（错误信息定位到账户） |
| 26 | restate 修改了 SETTLED 指令的金额 |
| 27 | merge 跨账户或跨币种 |

## 库 API

```js
const { applyPatch } = require('./src/migrate');   // -> { instructions, proof }，违规抛 MigrateError(exitCode)
const { verifyProof } = require('./src/verify');   // -> { ok: true } | { ok: false, invariant, message }
```

## 测试（真实运行结果）

测试于 2026-10-03 在本环境（Node.js v22.22.1）实际执行，命令 `node --test`，结果：

```
ok 1 - test/migrate.test.js
ok 2 - test/replay.test.js
ok 3 - test/verify.test.js
# tests 3
# pass 3
# fail 0
```

共 17 个子测试全部通过（migrate 8、verify 7、replay 2），覆盖：

- split/merge/restate 组合迁移及 proof 自洽（`test/migrate.test.js`）。
- 守恒破坏定位账户（exit 25，错误信息含账户名与净额/冻结差值）。
- SETTLED 金额保护（exit 26）与 merge 跨账户/跨币种（exit 27），库层与 CLI 层均验证。
- proof 篡改：伪造 `perAccountDelta`、删改 `ops`/`conservation`、非空 `forbiddenOps`，
  以及"篡改新表中 SETTLED 金额并伪造配套 proof"——均被首个对应不变量拒绝（`test/verify.test.js`）。
- 独立参考实现重放（`test/replay.test.js`）：对 n ≤ 9 的随机指令集（400 组种子确定性用例，
  每组 1–5 个合法 op），用测试内独立的 Map 版参考实现重放所有合法 patch，
  逐条比较最终表、`perAccountDelta`，并验证 proof 通过。

另外通过真实命令行做了端到端冒烟：migrate → verify 全链路 exit 0；
篡改 proof 后 `FAIL perAccountDelta` exit 1；三类违规分别 exit 25/26/27。
