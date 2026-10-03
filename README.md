# cnc-tool-life

CNC 刀具寿命服务：通过不可靠报文链路（重复、乱序、超时重传）同步刀具磨损状态。
Node.js 22，仅标准库，测试用 `node:test`，单机离线运行。

## 报文格式（ops.json）

数组或 `{ "ops": [...] }`，每个元素：

```json
{"t": 5, "type": "MEASURE", "tool": "T1", "wear": 82, "seq": 5, "sent": 4}
{"t": 6, "type": "CHANGE", "tool": "T1", "new": "T2", "seq": 6}
{"t": 7, "type": "RESET",  "tool": "T2", "admin": "root", "seq": 7}
```

- `t`：到达时的虚拟时钟；`sent`（仅 MEASURE，可缺省=t）：测量时刻。
- `seq`：全局序号，用于去重与乱序判定。

## 语义

- **去重**：`seq` 已确认的重传报文忽略（`DUPLICATE` 证据），不重复累计、不重复扣预算。
- **乱序**：`seq` 小于已确认最大序号的旧报文忽略，但保留证据（`OUT_OF_ORDER`）。
- **过期**：虚拟时钟 `now - sent > window` 的 MEASURE 忽略（`EXPIRED` 证据），`--window` 控制窗口。
- **MEASURE**：wear 单调非降，取绝对值（非累加）；出现下降即单调破坏，中止并 exit 11。
  活动刀具 wear >= limit 触发 `LIMIT_REACHED` 报警。
- **CHANGE**：清零旧 tool、绑定 new tool，消耗 1 次预算；进入未确认状态，
  直到新 tool 的后续 MEASURE 到达才确认（`CHANGE_CONFIRMED`）。
- **RESET**：仅当无未确认 CHANGE 且当前活动刀具 wear >= limit 才允许；
  否则拒绝（`PENDING_CHANGE` / `NOT_ACTIVE` / `BELOW_LIMIT`）。成功后 wear 清零，消耗 1 次预算。
- **预算**：每班磨刀次数上限 `--max`，CHANGE 与 RESET 各消耗 1；超限命令原子拒绝
  （`BUDGET_EXCEEDED`，状态与预算均不变，不得半提交），并以 exit 5 结束。

## 退出码

| code | 含义 |
|---|---|
| 0 | 正常 |
| 5 | 发生预算超限拒绝 |
| 11 | wear 单调性破坏 |
| 2 | CLI 用法/输入错误 |

## 用法

```sh
node cli.js ops.json --limit 80 --max 3 [--window 30] [--pretty]
node --test
```

输出 JSON：寿命曲线 `curve`、报警 `alarms`、拒绝原因 `rejections`、证据 `evidence`、
最终状态与 `exitCode`。

## 测试

- `test/engine.test.js`：重传/乱序不重复累计、CHANGE 未决时 RESET 拒绝、
  恰好 limit 边界、单调破坏 exit 11、预算原子拒绝 exit 5、过期窗口，
  以及与独立暴力重放 oracle 对照 500 条随机小序列（含重复与乱序）。
- `test/cli.test.js`：CLI 退出码与输出（沙箱禁止子进程，故经 `runCli` 进程内驱动同一代码路径）。

## 真实运行结果（2026-10-03，Node v22.22.1）

```
$ node cli.js examples/ops.json --limit 80 --max 3   -> exit 0
  budgetUsed=2, activeTool=T2, wear=0,
  alarms: LIMIT_REACHED wear=82 (T1), LIMIT_REACHED wear=80 (T2),
  rejections: seq 7 PENDING_CHANGE,
  evidence: DUPLICATE seq 2, OUT_OF_ORDER seq 3, CHANGE_CONFIRMED seq 6
$ node cli.js test/fixtures/budget.json --limit 80 --max 1    -> exit 5 (BUDGET_EXCEEDED, 无半提交)
$ node cli.js test/fixtures/monotonic.json --limit 80 --max 3 -> exit 11 (wear 50 -> 40)
$ node cli.js                                                 -> exit 2 (usage)
$ node --test                                                 -> 2 files, pass 2, fail 0
```
