# RESULTS — 真实测试与运行结果

环境：Node.js v22.22.1，仅标准库，`node:test`。日期：2026-10-08。

## 测试总览（`node --test`）

```
ok 1 - test/cli.test.js
ok 2 - test/engine.test.js
ok 3 - test/equiv.test.js
ok 4 - test/rules.test.js
ok 5 - test/scale.test.js
ok 6 - test/state.test.js
ok 7 - test/tokenize.test.js
# tests 7
# pass 7
# fail 0
```

逐文件子测试（共 26 个，全部通过）：

```
test/cli.test.js: 4 subtests ok
test/engine.test.js: 3 subtests ok
test/equiv.test.js: 3 subtests ok
test/rules.test.js: 3 subtests ok
test/scale.test.js: 1 subtests ok
test/state.test.js: 8 subtests ok
test/tokenize.test.js: 4 subtests ok
```

## 验收 A：高风险组合拒绝（test/engine.test.js）

规则 `high = [a3t0r2c*h1]`（大额+凌晨+受制裁地区+有历史标记）：

- 干净交易 APPROVE；命中交易 token `a3t0r2c1h1` REJECT，命中规则 `["high"]`
- apply 后被拒交易冻结额为 0（`state.accounts.acct1.frozen === 500`，仅含通过交易）
- 序列规则 `[***c1*][***c1*][***c1*]` 在完成第三笔连续线上交易处拒绝

## 验收 B：等价规则证书一致（test/equiv.test.js）

- `[a3***h0]|[a3***h1]` 与 `[a3****]`：证书完全相同，`equiv=true`，`witness=null`
- `[a3****]+` 与 `[a3****][a3****]*`：证书完全相同
- CLI 实测（examples/rulesA.re vs examples/rulesB.re）：

```
"equiv": true, "witness": null,
"certA": { "states": 6, "hash": "1bb6d4645d3ab931773c5d0e23a3651bb5c3c38631b2539cee88acec283920a8" },
"certB": { "states": 6, "hash": "1bb6d4645d3ab931773c5d0e23a3651bb5c3c38631b2539cee88acec283920a8" }
```

## 验收 C：不等价见证 + 独立枚举验证（test/equiv.test.js）

A=`[a3****][a3****]`，B=`[a3****][a3***c0*]`：

- 见证 `["a3t0r0c0h0","a3t0r0c1h0"]`，长度 2 ≤ 8
- 独立枚举验证（不经过等价算法，直接跑两个 DFA）：
  1. 见证本身区分两 DFA（A 接受、B 拒绝）
  2. 全部 289 条长度 < 2 的 token 串（全字母表 288 + 空串）均不区分
  3. 全部字典序更小的等长串均不区分
- CLI 实测（rulesA.re vs rulesC.re，burst 三笔 vs 四笔）：
  `"equiv": false, "witness": ["a0t0r0c1h0","a0t0r0c1h0","a0t0r0c1h0"]`

## 验收 D：apply 中断恢复不重复扣减（test/state.test.js）

显式故障点 FP1（写决定前）/ FP2（写决定后未 checkpoint）/ FP3（checkpoint 后未提交）：

- 三个故障点分别注入崩溃（`FAULT_INJECTED`），`recover()` 后重放 apply，
  额度均只扣减一次：`acct1.frozen === 350`（100+250），被拒的 30000 冻结 0
- FP1 崩溃时 journal 未写入，`recover` 返回 `{recovered:false}`；FP2/FP3 返回
  `{recovered:true, action:"rollback"}`
- 提交后、journal 清理前崩溃：`recover` 返回 `action:"finalize"`，状态不变；
  重放同批次报 `APPLY_CONFLICT`，不会二次扣减
- CLI 实测：`--fault FP3` → `{"error":"FAULT_INJECTED"}`；`recover` →
  `{"recovered":true,"action":"rollback","batchId":"demo-1"}`；重放 apply 成功，
  `state.json` 中 `acct1.frozen=1280, acct2.frozen=300`（被拒交易未冻结）

## 验收 E：undo 空栈报码（test/state.test.js, test/cli.test.js）

- 空历史 undo 抛 `UNDO_EMPTY`；apply→undo 后额度回到 apply 前，再次 undo 仍 `UNDO_EMPTY`
- CLI 实测：`{"error":"UNDO_EMPTY","message":"nothing to undo: apply history is empty"}`，退出码 1

## 错误码覆盖

| 错误码 | 触发测试 |
| --- | --- |
| TOKEN_UNKNOWN | test/tokenize.test.js（region="moon"、负金额） |
| RULE_CYCLE_UNSUPPORTED | test/rules.test.js（`x=@y,y=@x`、自引用） |
| APPLY_CONFLICT | test/state.test.js（重复批次、未恢复 journal） |
| UNDO_EMPTY | test/state.test.js、test/cli.test.js |

## 规模（test/scale.test.js）

- 100,000 笔交易、3 条规则（单条均 ≤ 60 字符），实测输出：
  `100k tx evaluated in 78ms, rejects=34568`
