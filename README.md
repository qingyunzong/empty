# settlement-migrator

监管报送前，把旧结算指令集迁移到新格式，并生成可独立校验的等价性证明（proof）。
仅使用 Node.js 标准库（Node 22），单机离线，无第三方依赖。

## 用法

```sh
node cli.js migrate <old.json> <patch.json> [--out new.json] [--proof proof.json]
node cli.js verify  <old.json> <new.json> <proof.json>
```

`--out` / `--proof` 缺省为 `new.json` / `proof.json`。

## 数据格式

指令（instruction）：

```json
{ "id": "a", "account": "alice", "debit": 10, "credit": 4, "freeze": 2,
  "state": "PENDING", "currency": "USD", "memo": "" }
```

- `debit` / `credit` / `freeze`：非负安全整数（最小货币单位），缺省 0。
- `state`：`PENDING` | `SETTLED` | `CANCELLED`，缺省 `PENDING`。
- `currency` / `memo`：可选，缺省 `null` / `""`。

patch 文件为 op 数组或 `{ "ops": [...] }`：

- `split(id, parts)`：把一条指令拆成 ≥2 条。各部分继承原指令的
  account/currency/state；各部分的 debit、credit、freeze 之和必须分别等于原值
  （按账户守恒）。part 不得指定不同的 account/currency。
- `merge(ids, newId)`：把 ≥2 条同账户、同币种的指令合并为一条，金额为逐项求和；
  成员 state 全同则保留，否则为 `PENDING`。
- `restate(id, fields)`：修改 `debit/credit/freeze/state/memo`。
  对已 `SETTLED` 的指令只允许改 `memo`，改金额或状态即拒绝。

## proof 与不变量

`migrate` 成功时输出 proof：

```json
{ "version": 1,
  "perAccountDelta": { "alice": { "net": 3, "freeze": 0 } },
  "conservation": { "ok": true, "accounts": ["alice"], "residual": { "alice": { "net": 0, "freeze": 0 } } },
  "forbiddenOps": [] }
```

- `perAccountDelta`：restate 引起的每账户净额（debit−credit）与 freeze 变化；
  split/merge 经验证守恒，贡献恒为 0。
- `verify` 不依赖 patch，按序重算并校验不变量，**失败时只报告首个失败不变量**：
  1. `schema` — proof 结构完整（exit 1）
  2. `conservation` — old/new 每账户实际 delta 与 `perAccountDelta` 完全一致（exit 25）
  3. `settledProtection` — old 中 `SETTLED` 且 id 仍存在的指令金额与状态未被改动（exit 26）
  4. `forbiddenOps` — proof 中该列表必须为空（exit 1）

## 退出码

| code | 含义 |
| ---- | ---- |
| 0 | 成功 |
| 1 | verify 不变量失败（schema / forbiddenOps） |
| 2 | 用法 / 输入校验错误 |
| 25 | 守恒破坏（migrate 拒绝或 verify conservation 失败），报错信息含 `account=<账户>` |
| 26 | 改动 SETTLED 指令金额/状态 |
| 27 | merge 跨账户或跨币种 |

## 示例

```sh
cd examples
node ../cli.js migrate old.json patch.json --out new.json --proof proof.json
# migrated: 3 -> 3 instructions (3 ops)
node ../cli.js verify old.json new.json proof.json
# OK: all invariants hold (conservation, settledProtection, forbiddenOps)
```

篡改 proof（把 `perAccountDelta.alice` 改成 `{net:1,freeze:0}`）后：

```
FAIL invariant=conservation account=alice: conservation mismatch for account=alice: declared delta net=1 freeze=0, actual delta net=0 freeze=0
exit=25
```

## 测试

```sh
node --test
```

测试构成：

- `test/migrate.test.js`：split/merge/restate 单元语义、组合序列、三类业务退出码。
- `test/verify.test.js`：proof 篡改（perAccountDelta 造假、new.json 金额漂移、
  SETTLED 金额篡改、forbiddenOps 非空、结构损坏、多不变量同时破坏时报告首个）。
- `test/cli.test.js`：CLI 端到端（进程内调用 `main()`，因为沙箱禁止 spawn 子进程），
  覆盖 migrate→verify 往返、25/26/27 退出码与账户定位。
- `test/reference.test.js`：对 n=1..9 的指令集（种子化 PRNG 生成，金额 0..3，
  3 账户 × 2 币种），用**独立参考实现**（`test/helpers/reference.js`，与 src 无共享代码）
  重放合法 patch 并逐条比较最终表，且每个 proof 都必须通过 verify：
  - 穷举全部合法单 op patch（所有 2 路 split 切分 × 所有同账户同币种 merge 子集
    × 所有合法 restate 字段修改）；
  - 每个 n 抽样 400 个二 op 序列、200 个长度 2..4 的多 op 序列
    （每步在当前表上重新枚举合法 op，种子可复现）。
  - 说明：合法 patch 全集无限（id/金额无界），此处穷举的是上述有限、明确界定的
    搜索空间，多 op 组合为种子化抽样而非穷举。

真实运行结果（2026-10-03，Node v22.22.1，本仓库工作区）：

```
# tests 33（migrate 10 + verify 7 + cli 7 + reference 9）
# pass 33
# fail 0
```

以上数字来自实际执行 `node --test` 及各测试文件的输出，非估算。
