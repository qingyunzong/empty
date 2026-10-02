# RESULTS

环境：Node.js v22.22.1（仅标准库，node:test，离线单机）
日期：2026-10-03

## 测试命令

```sh
node --test
```

## 真实运行结果

`node --test`（TAP 汇总）：

```
1..2
# tests 2
# suites 0
# pass 2
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

`node test/settle.test.js`（子测试明细）：

```
ok 1 - tier boundary 999 vs 1000
ok 2 - post-snapshot correction only enters supplement, snapshot hash unchanged
ok 3 - tied rules break by ascending rate then ruleId
ok 4 - E_LINK on dangling or repeated correction links
ok 5 - E_SNAPSHOT on duplicate snapshot and hash mismatch
ok 6 - cli writes settle.json and exits 0
ok 7 - cli exits 1 with E_LINK and E_SNAPSHOT
# tests 7
# pass 7
# fail 0
```

`node test/random.test.js`（子测试明细）：

```
ok 1 - random replay (n<=200) matches naive full recompute
# tests 1
# pass 1
# fail 0
```

合计 8/8 通过，0 失败。

## 验收标准对照

1. 跨阶梯边界 999/1000：`tier boundary 999 vs 1000` —— 999 落入 min=0 档
   （rebate=9），1000 落入 min=1000 档（rebate=20）。通过。
2. 快照后更正只进 supplement：`post-snapshot correction only enters supplement,
   snapshot hash unchanged` —— 快照 volume/rebate/hash 冻结不变，更正只出现在
   `s1-sup-1` 批次的 delta 中。通过。
3. 并列规则 tie-break：`tied rules break by ascending rate then ruleId` ——
   同 ts 并列先按费率升序，再按 ruleId 升序；商户级覆盖产品级；最近定义优先。通过。
4. 随机 n<=200 对照：`random replay (n<=200) matches naive full recompute` ——
   60 个种子、每个 1..200 条随机事件（rule/charge/correct/snapshot），与测试内
   独立的简单全量重算参考实现逐字段比对（volume/rebate/ruleId/supplement delta）。
   通过。

错误路径：`E_LINK`（悬空 linksTo、重复冲正同一 charge）与 `E_SNAPSHOT`
（重复快照、快照哈希不匹配）均抛出对应错误码；CLI 退出码 1 已由测试
`cli exits 1 with E_LINK and E_SNAPSHOT` 验证。

## CLI 冒烟（真实运行）

```sh
node cli.js events.jsonl settle.json   # 正常结算，退出码 0
node cli.js bad.jsonl out.json         # 输出 "E_LINK correction x1 links to unknown event ghost"，退出码 1
```
