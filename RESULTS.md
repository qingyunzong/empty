# RESULTS — 真实运行记录

环境：Node.js v22.22.1（仅标准库），Linux 单机离线。运行时间：2026-10-04。

## 测试套件（`node --test`）

```
ok 1 - test/brute.test.js
ok 2 - test/cli.test.js
ok 3 - test/expr.test.js
ok 4 - test/linearize.test.js
ok 5 - test/typecheck.test.js
# tests 5
# pass 5
# fail 0
# duration_ms 34937.039316
```

各文件覆盖：

- `test/expr.test.js`：词法（含 reserve/confirm/release、invoke/response/pending 等关键字）、
  Pratt 解析优先级/结合性、容量约束表达式编译为字节码并求值。
- `test/typecheck.test.js`：子限额总和超容量、confirm 无对应 reserve、重复 release、
  未声明订单/账户/策略、不变式非法引用、非常量 capacity、response 早于 invoke —— 全部 E_TYPE。
- `test/linearize.test.js`：验收 1（三操作并发一成功一失败）、验收 2（PENDING 不武断拒绝）、
  PENDING 无法挽救不可能记录、多解按字典序输出、验收 5（超规模 E_BOUND、工作上限 E_BOUND）。
- `test/brute.test.js`：验收 4 —— 400 个确定性随机种子（n <= 8，含 PENDING/confirm/release/
  重复 reserve），剪枝枚举器与独立暴力排列参考实现 verdict 与全部合法顺序逐一相等。
- `test/cli.test.js`：CLI 端到端（进程内调用 main()，因沙箱禁止 spawn 子进程）：
  退出码 0/1/2/3/4 与 JSON 输出。

## CLI 实跑

```
$ node bin/limit.js check examples/reserve.lim examples/history-ok.json --max 8
{
  "linearizable": true,
  "count": 1,
  "validOrders": [
    [
      "A",
      "B",
      "C"
    ]
  ],
  "pending": [],
  "explored": 4,
  "warnings": []
}
exit=0

$ node bin/limit.js check examples/reserve.lim examples/history-pending.json
{
  "linearizable": true,
  "count": 1,
  "validOrders": [
    [
      "A",
      "B"
    ]
  ],
  "pending": [
    "A"
  ],
  "explored": 4,
  "warnings": [
    {
      "code": "E_PENDING",
      "message": "1 operation(s) have no recorded response and were treated as possibly completed: A"
    }
  ]
}
exit=0

$ node bin/limit.js check examples/reserve.lim examples/history-conflict.json
{
  "linearizable": false,
  "error": {
    "code": "E_LINEAR",
    "message": "no sequential order satisfies the capacity constraints and the real-time order"
  },
  "pending": [],
  "explored": 2,
  "warnings": []
}
exit=1

$ node bin/limit.js check examples/reserve.lim examples/history-dup-release.json
{"error":{"code":"E_TYPE","message":"duplicate release of order 'o1' (op 'C')"}}
exit=2
```
