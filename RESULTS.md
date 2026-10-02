# RESULTS — 真实运行结果

环境:Node.js v22.22.1,单机离线,仅标准库 + node:test。运行日期 2026-10-02。

## 1. 测试套件 `node --test test/*.test.js`

```
ok 1 - test/cli.test.js
ok 2 - test/concurrency.test.js
ok 3 - test/judge.test.js
ok 4 - test/repair.test.js
ok 5 - test/ties.test.js
# tests 5
# suites 0
# pass 5
# fail 0
# duration_ms 24311.093633
```

## 2. 验收对照

| 验收项 | 结果 | 证据 |
|---|---|---|
| 5账户×200操作随机并发,judge 与 n≤8 暴力枚举线性化对照 | 通过 | `test/concurrency.test.js`(1008 个 op,判定 2262ms,两次运行结果 deepEqual,额度/日上限不变量成立);`test/ties.test.js` 150 组 n=2..8 随机历史,judge 的 `tiedOptimal.sequences` 与暴力枚举全部线性化后按判定向量分组的结果逐一 deepEqual |
| 注入 repair 后重放旧 history 结果不变 | 通过 | `test/repair.test.js` "replaying old history after repair injection yields unchanged results":repair 仅追加,旧 history 字节前缀不变;重放旧 history 与 repair 后全量 history 中原始 op 的判定向量、可用额度完全一致 |
| 崩溃在写补偿前,恢复后补偿恰好一次 | 通过 | `test/repair.test.js` "crash before writing all compensations...":`crashAfterWrites:1` 注入崩溃后已写 1 条,恢复后补写 3 条,第三次运行为 no-op,4 条补偿 opId 唯一 |
| 并列最优 release 序列输出稳定排序 | 通过 | `test/ties.test.js`:并发同额 release 的全部并列最优序列按 opId 字典序稳定输出,多次运行一致;`test/cli.test.js` 断言两次 `node cli.js judge` 输出逐字节相同 |

## 3. CLI 演示(真实输出摘录)

history:freeze 100 → hold 40 → release 30 → release 30 → release 80(超限)→ freeze 90(超日上限),config `{"default":{"limit":200,"dailyFreezeCap":150}}`。

`node cli.js judge --history history.ndjson --config config.json`:

- `available: 160`,`frozenTotal: 40`(100 冻结 − 30 − 30 部分释放,hold 40 已含其中)
- `r3` code=10(释放多于冻结),`f2` code=13(日冻结上限,不得部分生效)
- `tiedOptimal.count: 60`,序列按字典序稳定排列
- 重复 `append --opId f1` 被拒绝:`{"error":"duplicate opId: f1","code":12,"reason":"duplicate_opId"}`,exit=1

`node cli.js repair --crash-after 1`(模拟崩溃)→ exit=2,已写 `cmp:r3`;
再次 `node cli.js repair` → 补写 `cmp:f2`,`skipped: ["cmp:r3"]`;
第三次 `node cli.js repair` → `added: []`,补偿恰好一次。

## 4. 错误码覆盖

code 10/11/12/13/14/15/16 均在 `test/judge.test.js` 中有正向断言;
10/12/13/15 在 5×200 随机并发历史中自然出现并被断言。
