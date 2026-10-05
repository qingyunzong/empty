# RESULTS — 真实测试运行记录

环境：Node.js v22.22.1，仅标准库，单机离线。运行日期：2026-10-06。

## 总览：`node --test`

```
# tests 7        # 7 个测试文件
# pass 7
# fail 0
# duration_ms 3250.78
```

子测试明细（逐文件 `node <file>` 统计 `^ok` 行数）：

| 测试文件 | 子测试 | 覆盖验收项 |
| --- | --- | --- |
| test/tokens.test.js | 5 ok | 分档边界、TOKEN_UNKNOWN、字母表序 |
| test/regex.test.js | 7 ok | 解析、RULE_CYCLE_UNSUPPORTED、60 字符上限 |
| test/automata.test.js | 5 ok | B：等价证书一致、确定性、最小化 |
| test/equiv.test.js | 5 ok | C：见证 + 长度≤8 独立枚举验证 |
| test/engine.test.js | 5 ok | A：高风险组合拒绝、流式语义 |
| test/apply.test.js | 9 ok | D：三故障点恢复不重复扣减；E：UNDO_EMPTY |
| test/scale.test.js | 1 ok | 10 万交易规模 |

合计 37 个子测试全部通过。

## A：高风险组合拒绝（test/engine.test.js）

规则集（`XNF..`、`(HNF..)(HNF..)`、`...A1`）下：

- 单笔 50000 元夜间境外交易 → REJECT（`XNF..` 命中）
- 连续两笔高金额境外夜间 → 第二笔 REJECT（成对模式完成）
- 单笔高金额境外夜间（无连续）→ ACCEPT
- ATM + 历史标记 → REJECT；POS + 历史标记 → ACCEPT
- 间隔正常交易的两笔高金额境外夜间 → 均 ACCEPT（无误报）

## B：等价规则证书一致（test/automata.test.js + CLI）

```
$ node cli.js equiv eqA.re eqB.re     # [HX]NF..  vs  HNF..|XNF..
{
  "equiv": true,
  "certA": { "states": 3, "hash": "2767fb8c94664d9b1532ac1d73baeabd7c0a4c06dc94efce08591ea1cede98a2" },
  "certB": { "states": 3, "hash": "2767fb8c94664d9b1532ac1d73baeabd7c0a4c06dc94efce08591ea1cede98a2" },
  "witness": null
}
```

其他通过的一致证书用例：并集顺序无关、`(HNF..)*` ≡ `((HNF..)(HNF..)*)?`、
多行规则文件 ≡ 单条 alternation、`.....*` 最小化为 1 状态。

## C：不等价见证 + 独立枚举验证（test/equiv.test.js）

```
$ node cli.js equiv eqA.re neB.re     # [HX]NF..  vs  HNF..
{
  "equiv": false,
  "certA": { "states": 3, "hash": "2767fb8c...e98a2" },
  "certB": { "states": 3, "hash": "ffa29edf...b977" },
  "witness": { "tokens": ["XNFP0"], "text": "XNFP0", "length": 1 }
}
```

见证由 `src/brute.js` 的独立回溯匹配器（与 NFA/DFA 管线零共享代码）验证：
对长度 ≤8 的 token 串按字典序枚举，首个分歧串与 BFS 见证完全一致。用例：

- `[HX]NF..` vs `HNF..` → `["XNFP0"]`（长度 1）
- `(L....)(L....)` vs `(L....)(M....)` → `["LNDP0","LNDP0"]`（长度 2）
- `(HNF..)?` vs `HNF..` → `[]`（空串，长度 0）
- `(HNF..)*` vs `(HNF..)+` → `[]`（空串）

## D：apply 中断恢复不重复扣减（test/apply.test.js + CLI 实录）

三个显式故障点（`--fail-at`，进程退出码 70 模拟崩溃）：

```
--- F1 before-decision（写决定前崩溃）
{"error":"FAULT_INJECTED","point":"before-decision"}            exit=70
# 无状态文件、无日志残留；直接重试 apply 成功，used=300（只扣一次）

--- F2 after-decision（决定已写、未写检查点）
{"error":"FAULT_INJECTED","point":"after-decision"}             exit=70
再次 apply → {"error":"APPLY_CONFLICT", ...}                    exit=1
recover → {"recovered":[]}        # 无检查点，无提交，额度不变
重试 apply 成功，used 正常累加

--- F3 after-checkpoint（检查点已写、未提交）
{"error":"FAULT_INJECTED","point":"after-checkpoint"}           exit=70
recover → {"recovered":["run-1791243622951-17"], ...}           # 提交一次
recover → {"recovered":[]}        # 幂等：used=900 而非 1200
```

undo 实录：连续 3 次 undo 依次回滚 3 个 run，第 4 次：

```
{"error":"UNDO_EMPTY","message":"undo stack is empty"}          exit=1
```

最终 `used: 0`（全部回滚）。被拒绝交易（t3，99999 元，XNF.. 命中）
不产生任何额度冻结：clean apply 后 `used=300`（仅 t1+t2）。

## E：undo 空栈报码

`test/apply.test.js` 两条：全新状态 undo → UNDO_EMPTY；apply 一次后
undo 两次 → UNDO_EMPTY。CLI 退出码 1，stderr 输出 `{"error":"UNDO_EMPTY"}`。

## 规模：10 万交易

- 引擎内评估（test/scale.test.js）：`100k transactions evaluated in 32.2ms (8508 hits)`，
  并逐笔与规则语义交叉校验 100000 条命中标志。
- CLI 端到端（`node cli.js run hi.re big.jsonl --mode dry-run --quota 100000000`）：
  100000 条决定，约 2 秒完成，`summary: {"ACCEPT":91492,"REJECT":8508,"ERROR":0}`，
  REJECT 数与引擎命中数一致。

## 错误码覆盖

| 错误码 | 触发场景 | 测试 |
| --- | --- | --- |
| TOKEN_UNKNOWN | 未知地区/渠道/金额/小时/历史标记 | tokens.test.js、apply.test.js |
| RULE_CYCLE_UNSUPPORTED | `@a→@b→@a` 等引用环 | regex.test.js |
| APPLY_CONFLICT | 存在未完成 apply 时再次 apply | apply.test.js |
| UNDO_EMPTY | 空栈 undo | apply.test.js |
