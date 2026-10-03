# 三层对账 / 回滚 / 预算 — 实现与验收结果

环境：Node.js v22.22.1，仅标准库 + node:test，单机离线。

## 结构

- `lib/csv.js` — CSV 解析/序列化（含引号转义）
- `lib/store.js` — 状态持久化（`state/batches.json`、`budgets.json`、`journal.json`），原子写（tmp+rename），启动时按 journal 恢复未完成的操作
- `lib/reconcile.js` — 匹配键 = 金额 + 币种 + 时间窗；支持一对一、一对多/多对一（子集总额相等）；同额并列全部列入 `alternatives` 并选字典序最小
- `lib/rollback.js` — 依赖闭包（DFS）与暴力枚举对照、循环检测（code=20）、孤儿回单检测（code=21）、分层回滚（高层级先处理）；银行已确认批不回滚，生成 `ADJ-<batchId>` 反向调整，原批状态不变
- `lib/budget.js` — 客户日净额上限校验，越界（超上限或净额为负）整批失败 code=22，禁止部分扣减
- `cli.js` — `node cli.js reconcile|rollback|budget`

## 测试（node --test test/*.test.js）

```
ok 1 - test/budget.test.js
ok 2 - test/cli.test.js
ok 3 - test/reconcile.test.js
ok 4 - test/rollback.test.js
# tests 4
# pass 4
# fail 0
```

## 验收对照

1. **100 批嵌套依赖，rollback 与 n≤9 枚举闭包对照** — `test/rollback.test.js`：
   确定性 PRNG 生成 100 批嵌套 DAG，每个节点的 `dependencyClosure`（DFS）与 `bruteForceClosure`（不动点枚举）逐一相等；另对 n=1..9 × 20 个种子 × 每个节点全量对照，全部通过。
2. **已确认银行批触发反向调整且原批状态不变** — 见下方 CLI 实录：`B3`（银行层、回单 confirmed=true）保持 `active`，生成 `ADJ-B3 amount=-600 kind=reversal`。
3. **崩溃在更新预算后未写回滚标记，恢复后预算不双扣** — `test/budget.test.js`：`failAfter:'budget'` 模拟崩溃，预算已写（600→0）、回滚标记未写；重新 `Store.load()` 触发 journal 恢复，仅补写回滚标记，净额保持 0（若双扣则为 -500/-600，断言为 0 通过）。
4. **同额并列匹配全部列出并选字典序最小** — `test/reconcile.test.js`：候选 `R1,R2` 同额同窗，`alternatives=['R1','R2']`，选中 `R1`。

## CLI 实录

### reconcile（一对多：T1+T2=CL1；CL9 无银行回单进入 unmatched）

```
$ node cli.js reconcile --channels channels.csv --clearing clearing.csv --bank bank.csv --window 60 --out out
channel-clearing: matched=2 unmatched_channel=0 unmatched_clearing=0
clearing-bank: matched=1 unmatched_clearing=1 unmatched_bank=0
wrote out/matched.csv and out/unmatched.csv

matched.csv:
pair,left,right,amount,currency,alternatives
channel-clearing,T9,CL9,1500,CNY,CL9
channel-clearing,T1+T2,CL1,600,CNY,T1+T2
clearing-bank,CL1,R1,600,CNY,R1

unmatched.csv:
pair,side,id
clearing-bank,clearing,CL9
```

### budget（越界整批失败，code=22，无部分扣减）

```
$ node cli.js budget set --customer C1 --date 2026-10-01 --limit 1000 --data .
limit set: customer=C1 date=2026-10-01 limit=1000
$ node cli.js budget apply --batch B1 --data .
applied=true net=600
$ node cli.js budget apply --batch B4 --data .   # B4=1500，600+1500>1000
error code=22 budget violation for C1 on 2026-10-01: net=2100 limit=1000   (exit=22)
$ node cli.js budget check --customer C1 --date 2026-10-01 --data .
customer=C1 date=2026-10-01 net=600 limit=1000 status=ok   # 仍为 600，未部分扣减
```

### rollback（分层回滚 + 已确认银行批反向调整）

```
$ node cli.js rollback --batch B1 --data .
rolled_back: B2,B1
reversal_adjustment: ADJ-B3 parent=B3 amount=-600 CNY
$ node cli.js budget check --customer C1 --date 2026-10-01 --data .
customer=C1 date=2026-10-01 net=0 limit=1000 status=ok

state/batches.json:
B1  status=rolled_back
B2  status=rolled_back
B3  status=active          # 银行已确认，原批不变
ADJ-B3 amount=-600 kind=reversal status=active
```

### 错误码

```
$ node cli.js rollback --batch B1 --data .   # bank.csv 含 batchId=GHOST 的回单
error code=21 orphan receipt R9 references unknown batch GHOST   (exit=21)

$ node cli.js rollback --batch B1 --data .   # B1<->B2 循环依赖
error code=20 cyclic dependency detected at batch B1   (exit=20)
```

## 命令

```
node --test test/*.test.js
node cli.js reconcile --channels <csv> --clearing <csv> --bank <csv> [--window 秒] [--out 目录]
node cli.js rollback --batch <batchId> --data <目录>
node cli.js budget set|apply|check --customer <id> --date <yyyy-mm-dd> [--limit N|--batch <id>] --data <目录>
```
