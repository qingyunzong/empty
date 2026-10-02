# RESULT — 真实输出摘要

日期：2026-10-03 ｜ 运行时：Node.js v22.22.1 ｜ 仅标准库 ｜ 测试命令：`node --test`

## 测试结果（node --test 实际输出）

```
✔ test/acceptance.test.js (1055.6ms)
✔ test/unit.test.js (1020.6ms)
ℹ tests 2
ℹ pass 2
ℹ fail 0
```

子测试明细：unit 11/11 通过，acceptance 5/5 通过（A 跨租户同设备、B 撤销前后查询+冻结统计+可解释审计、C 误报标记一致性、D ≤12 主体/标签枚举对照参考判定、CLI 退出码 4/8/9）。

## CLI 演示（fixtures/policy.json + fixtures/events.jsonl）

`query --tenant tenant-a --at 200`（位图 read=1/modify=2/mark_false_positive=4）：

```
{"event":"e1","tenant":"tenant-a","bitmap":7,"allowed":["read","modify","mark_false_positive"],"denied":[],"falsePositive":{"by":"tenant-a","at":160,"markingEvent":"e4"}}
{"event":"e2","tenant":"tenant-a","bitmap":1,"allowed":["read"],"denied":["modify","mark_false_positive"]}
{"event":"e3","tenant":"tenant-a","bitmap":7,"allowed":["read","modify","mark_false_positive"],"denied":[]}
{"event":"e4","tenant":"tenant-a","bitmap":0,"allowed":[],"denied":["read","modify","mark_false_positive"],"markingStatus":"applied"}
```

`query --tenant tenant-b --at 200`（跨租户对照：e1 无授权 bitmap=0；e2 停机+safety-public 公开可读；e3 事件级例外允许读）：

```
{"event":"e1","tenant":"tenant-b","bitmap":0,"allowed":[],"denied":["read","modify","mark_false_positive"]}
{"event":"e2","tenant":"tenant-b","bitmap":1,"allowed":["read"],"denied":["modify","mark_false_positive"]}
{"event":"e3","tenant":"tenant-b","bitmap":1,"allowed":["read"],"denied":["modify","mark_false_positive"]}
```

`stats`（派生统计快照不随后续撤销改变；第二次 `--at 9999` 仍返回原快照）：

```
{"tenant":"tenant-a","computedAt":200,"counts":{"read":3,"modify":2,"mark_false_positive":2},"snapshot":false}
{"tenant":"tenant-a","computedAt":200,"counts":{"read":3,"modify":2,"mark_false_positive":2},"snapshot":true}
```

audit.jsonl 样例（safety-public 打破/公开可读均记录理由；拒绝均含最小反例）：

```
{"type":"decision","at":200,"tenant":"tenant-a","event":"e1","action":"read","allow":true,"allows":[{"kind":"grant","id":"g1"}],"denies":[],"broken":[],"breakReason":null,"counterexample":null}
{"type":"decision","at":200,"tenant":"tenant-a","event":"e2","action":"read","allow":true,"allows":[],"denies":[],"broken":[],"breakReason":"safety-public shutdown event is publicly readable","counterexample":null}
```

## 退出码实测

- 租户环：`exit=4`
- 未知标签：`exit=9`
- 事件乱序超窗口（--window 100，ts 1000→10）：`exit=8`
