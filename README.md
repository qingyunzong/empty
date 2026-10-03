# risk-patch

风控每日迁移补丁工具：把账户额度与冻结状态从 base 迁到 target，产出**可审查、可回滚、可重放**的结构化补丁，而非整表覆盖。

- 运行环境：Node.js 22，仅标准库，单机离线
- 状态形状：`{ accounts: { [id]: { limit, used, holds: [{ hid, amount, tag }] } } }`
- 可用额：`available = limit - used - sum(holds)`

## 命令

```bash
node cli.js diff   <base.json> <target.json> --out <patch.json>
node cli.js apply  <state.json> <patch.json> [--dry-run]
node cli.js revert <state.json> <patch.json> [--dry-run]
```

## 补丁格式

```json
{
  "version": 1,
  "fromHash": "<sha256 of base>",
  "toHash": "<sha256 of target>",
  "ops": [ /* setLimit | addHold | removeHold | changeTag */ ],
  "sha256": "<sha256 of 以上字段，防篡改>"
}
```

- 哈希对**规范化状态**（每个账户的 holds 按 hid 排序、对象键排序）计算，与数组顺序无关。
- op 携带回滚所需的全部信息（`prevLimit` / `prevTag` / 被删的 `hold`），revert 按逆序应用逆 op。
- diff 生成的 op 顺序保证中间态合法：先 `removeHold`（释放），再 `setLimit`，再 `changeTag`，最后 `addHold`。

## 校验与语义

`apply` 逐 op 校验：`hid` 账户内唯一、`amount > 0`、可用额不为负、`limit >= used + sum(holds)`。
任一 op 失败则**整体原子回滚**（状态文件不写入），stderr 报告首个失败的 `opIndex`。

- **幂等**：当前哈希 == `toHash` 时 apply 为 no-op，重复 apply 安全。
- **revert**：仅当当前哈希 == `toHash` 才执行，否则拒绝。
- **dry-run**：完整校验并打印结果，但不落盘。

## 退出码

| code | 含义 |
| --- | --- |
| 0 | 成功（含幂等 no-op） |
| 2 | 用法 / 文件读取错误 |
| 6 | 哈希不匹配（状态漂移、补丁被篡改、错误 revert） |
| 7 | 额度不足 / 业务校验失败（含 hid 重复、amount<=0、limit<used+holds） |
| 8 | 未知 op |

## 真实运行记录

以下输出均在 `examples/` 目录下真实执行（base → target：a1 改标签，a2 降额并新增冻结）。

```
$ node ../cli.js diff base.json target.json --out patch.json
diff ok: ops=3 from=b35f80097f8f to=e7a842e04b93 sha256=2ed736d27536 -> patch.json
  op {"op":"changeTag","account":"a1","hid":"h1","tag":"review","prevTag":"fraud"}
  op {"op":"setLimit","account":"a2","limit":450,"prevLimit":500}
  op {"op":"addHold","account":"a2","hold":{"hid":"h9","amount":50,"tag":"audit"}}

$ node ../cli.js apply state.json patch.json --dry-run
apply ok: applied 3 ops (dry-run, state not written)
would-be state: hash=e7a842e04b93 accounts=2
  a1: limit=1000 used=200 holds=1 available=700
  a2: limit=450 used=0 holds=1 available=400

$ node ../cli.js apply state.json patch.json
apply ok: applied 3 ops
state: hash=e7a842e04b93 accounts=2
  a1: limit=1000 used=200 holds=1 available=700
  a2: limit=450 used=0 holds=1 available=400

$ node ../cli.js apply state.json patch.json   # 重复 apply：幂等
apply ok: already applied (idempotent no-op), hash=e7a842e04b93

$ node ../cli.js revert state.json patch.json
revert ok: reverted 3 ops
state: hash=b35f80097f8f accounts=2
  a1: limit=1000 used=200 holds=1 available=700
  a2: limit=500 used=0 holds=0 available=500

$ node ../cli.js revert state.json patch.json  # 错误 revert：拒绝
revert failed: state hash b35f80097f8f != patch toHash e7a842e04b93; refuse revert
exit=6
```

错误路径（真实输出）：

```
$ node ../cli.js apply s2.json evil.json        # 第二个 op 冻结 999 超过可用额
apply failed: opIndex=1 addHold 999 exceeds available 490
exit=7                                          # 状态文件未被修改（原子）

$ node ../cli.js apply s2.json badop.json       # 未知 op
apply failed: opIndex=0 unknown op: wipeAll
exit=8

$ node ../cli.js apply drifted.json patch.json  # 状态已被第三方改动
apply failed: state hash f37d16919384 != patch fromHash b35f80097f8f
exit=6
```

## 测试

```bash
node --test
```

- `test/patch.test.js`：新增/释放冻结、changeTag、超限原子失败（报告首个 `opIndex`）、
  幂等重复 apply、错误 revert 拒绝、未知 op、CLI 端到端退出码。
- `test/enumerate.test.js`：独立枚举器按混合进制穷举 n<=6（账户 ≤3、每账户冻结 ≤2、
  总冻结 ≤6）的状态空间，对 600 对 (base, target) 验证 diff → apply → revert 往返一致
  （`apply` 结果哈希 == `toHash`，`revert` 结果哈希 == `fromHash`，重复 apply 幂等）。

真实测试输出：

```
✔ test/enumerate.test.js (6497.124805ms)   # roundtrip ok: 600 pairs, 4275 ops
✔ test/patch.test.js (2508.428784ms)
ℹ tests 2
ℹ pass 2
ℹ fail 0
```

## 文件

- `patchlib.js` — 库：canonical/hash/diff/apply/revert，可 `require` 复用
- `cli.js` — 命令行入口（`run(argv)` 返回退出码，便于进程内测试）
- `test/` — node:test 测试
- `examples/` — README 中使用的样例 base/target/patch
