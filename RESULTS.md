# RESULTS（组17：风控额度 freeze/hold/release 并发判定与事后更正）

环境：Node.js v22.22.1，仅标准库 + `node:test`，单机离线。日期：2026-10-05。

## 验收命令真实输出

`node --test test/*.test.js`：

```
ok 1 - test/judge.test.js
ok 2 - test/linearization.test.js
ok 3 - test/repair.test.js
ok 4 - test/ties.test.js
# tests 4
# pass 4
# fail 0
# duration_ms ~5100
```

各文件内部用例数（共 17 个，全部通过）：

| 文件 | 用例数 | 覆盖 |
|---|---|---|
| test/judge.test.js | 8 | freeze/hold/release/unhold 单元语义、code=10/11/12/13/14、日预算重置、依赖环检测 |
| test/linearization.test.js | 2 | 验收1：n≤8 暴力枚举对照（300 组随机）；5账户×200操作随机并发 |
| test/repair.test.js | 4 | 验收2/3：重放不变、补偿生效、崩溃前后恢复恰好一次、被拒操作 no-op |
| test/ties.test.js | 3 | 验收4：同额并列最优全部列出、稳定排序、非并列时唯一最优 |

## 验收点落实情况

1. **5账户×200操作随机并发 + n≤8 暴力枚举对照**：`test/linearization.test.js`。
   生成器按「客服/批量」风格产生每账户 20 段 × 2-3 条并发车道（段末 sync 合并），
   共 1000 条操作。judge 输出与暴力枚举全部线性化的最优结果集逐一相等
   （score、并列 outcome 签名集、可用额度三项断言），300 组 n∈[2,8] 随机历史全过；
   1000 条规模下判定确定性（两次运行 deepStrictEqual）且每个 outcome 沿见证线性化
   重放满足：可用额度非负、日冻结预算不超限、释放不超过冻结、happens-before 有序。
2. **注入 repair 后重放旧 history 结果不变**：`test/repair.test.js` 第 1 例。
   修复前判定结果 V1 → 注入 3 条补偿 → 旧历史副本重放与 V1 完全相等；
   新历史中旧操作判定投影不变，补偿全部生效，可用额度 750 → 850。
3. **崩溃在写补偿前，恢复后补偿恰好一次**：`test/repair.test.js` 第 2、3 例。
   `REPAIR_CRASH_BEFORE_WRITE=1` 崩溃后日志零写入，恢复运行补偿恰好一次，再跑全部 skipped；
   `REPAIR_CRASH_MID_WRITE=1` 留下无换行的撕裂尾部，解析器跳过残片并告警，
   恢复后补偿仍恰好一次且判定正常。（沙箱禁止 spawn 子进程，崩溃通过 CLI 注入的
   env 钩子在进程内模拟，退出码 2。）
4. **并列最优 release 序列输出稳定排序**：`test/ties.test.js`。
   F=50 并发 r1=r2=30 → 恰好 2 个并列最优（各释放 30），按规范化签名稳定排序、
   多次运行一致，且与暴力枚举一致；root+A/B/C 同额冻结竞争给出 3 个并列最优；
   60 vs 50 不等额时仅输出唯一最优。

## CLI 真实演示（/tmp/demo17b）

历史：root freeze 10，A/B 并发 freeze 60（额度 100，日上限 1000）。

`node cli.js judge --history h.ndjson --config accounts.json` 关键输出：

```
available = 30, score = [70, 0, 2], outcomes = 2（同额并列，全部列出）
  outcome 1: root✓ A✗(code 11) B✓   signature [[0,null],[1,11],[2,null]]
  outcome 2: root✓ A✓ B✗(code 11)   signature [[0,null],[1,null],[2,11]]
```

`node cli.js repair --history h.ndjson --config accounts.json --op root`：

```
[{"op":"root","action":"compensate","compensation":{"opId":"cmp-root","account":"acc1",
  "type":"release","amount":10,"ts":4,"day":0,"deps":["A","B","root"],"compensates":"root",
  "freezeId":"root"}}]
```

补偿后 `available = 40`；再次 repair：`[{"op":"root","action":"skipped","reason":"compensation already exists"}]`（幂等）。

## 设计要点

- **语义**：每账户因果 DAG 上枚举线性化做贪心判定，最优 = 字典序最大
  （成功冻结总额， 成功释放总额， 成功操作数）；同分并列全部列出，签名稳定排序。
  judge 为带记忆化的精确 DFS（键 = 已处理集合 + 语义状态），与暴力枚举同语义、可扩展到
  并发宽度有界的百级历史。
- **错误码**：10 释放多于冻结 / 11 负可用 / 12 重复 opId（按日志文件序）/
  13 日冻结预算超限（整单拒绝、无部分生效）/ 14 非法依赖。
- **repair**：只追加补偿记录（freeze→release 剩余、release→同额 freeze 入新一天、
  hold↔unhold），`compensates` 字段保证幂等恰好一次；补偿依赖当前全部末端，
  因果上位于旧操作之后，故旧操作判定不变。
- **日志**：单行原子追加 + fsync；撕裂尾部隔离跳过并告警。
