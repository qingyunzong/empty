# cnc-tool-life

CNC 刀具寿命服务：通过不可靠报文链路（重复、乱序、超时重传）同步刀具磨损状态。
Node.js 22，仅标准库，测试使用 `node:test`，单机离线可运行。

## 运行

```sh
node cli.js ops.json --limit 80 --max 3 [--window N]
node --test
```

`ops.json` 是报文到达事件数组，字段：

```json
{ "t": 4, "type": "MEASURE", "tool": "T1", "wear": 80, "seq": 3, "sent": 4 }
{ "t": 6, "type": "CHANGE",  "tool": "T1", "new": "T2", "seq": 5 }
{ "t": 5, "type": "RESET",   "tool": "T1", "admin": "supervisor", "seq": 4 }
```

- `t`：到达时的虚拟时钟（缺省则每条报文 +1）；`sent`：发送时刻（缺省 = `t`）。
- `MEASURE` 仅在 `t - sent <= --window` 内有效，过期则忽略并保留证据（默认窗口无限）。
- 示例见 `examples/ops.json`。

## 状态机语义

- `MEASURE(tool, wear, seq)` 上报**累计磨损读数**（绝对值），每把刀独立维护 `lastSeq`：
  - `seq <= lastSeq`（重传 / 乱序旧报文）→ 忽略并记入 `ignored` 证据，不重复累计；
  - 新报文 `wear < 当前wear` → 单调性破坏，抛 `MonotonicityError`，CLI 退出码 **11**；
  - 接受后 `wear >= limit` 触发 `LIMIT_REACHED` 报警。
- `CHANGE(tool, new, seq)`：旧刀磨损清零、绑定新刀（新刀从 0 开始），消耗 1 次磨刀预算；
  进入“未确认”状态，直到新刀的第一条 `MEASURE` 到达才确认。同 `(tool, seq)` 重传幂等，不重复扣预算。
- `RESET(tool, admin, seq)`：仅当 **无未确认 CHANGE** 且 **wear >= limit** 且持有 `admin` 授权时执行，
  磨损清零并消耗 1 次预算；否则拒绝并记录原因（`NO_ADMIN` / `CHANGE_PENDING` / `BELOW_LIMIT`）。
- 预算：每班 `CHANGE + RESET` 合计不超过 `--max`；超限命令拒绝（`BUDGET_EXCEEDED`）且**不得半提交**
  （状态与预算均不变），CLI 退出码 **5**。

## 输出

stdout 打印 JSON 报告：`curve`（寿命曲线）、`alarms`（报警）、`rejections`（拒绝原因）、
`ignored`（被忽略报文的证据）、`final`（各刀磨损/已确认 seq、当前刀、未决 CHANGE、已用预算）。

退出码：`0` 正常；`5` 发生预算超限拒绝；`11` 单调性破坏；`2` 用法/输入错误。

## 验收测试（真实结果）

`node --test`（Node v22.22.1）最近一次运行：

```
ok 1 - acceptance 1: retransmit and reorder never double-accumulate
ok 2 - duplicate CHANGE/RESET are idempotent and do not consume budget twice
ok 3 - acceptance 2: RESET rejected while CHANGE is unconfirmed
ok 4 - acceptance 3: exact limit boundary for alarm and RESET
ok 5 - RESET without admin is rejected
ok 6 - virtual clock expires MEASURE outside the window, evidence kept
ok 7 - monotonicity violation on fresh MEASURE throws MonotonicityError
ok 8 - acceptance 4: brute-force replay of permuted+duplicated streams matches canonical
ok 9 - budget: over-limit command rejected without half-commit, exit 5
ok 10 - cli exits 0 and prints report on a clean run
ok 11 - cli exits 11 on monotonicity violation
ok 12 - cli exits 5 on budget exhaustion
ok 13 - cli exits 2 on bad usage
ok 14 - cli real process exit codes (skipped when spawn is sandboxed) # SKIP
# tests 14
# pass 13
# fail 0
# skipped 1
```

验收 4 对 seq 1..4 的全部 24 种排列 × 注入重复报文做暴力重放，
最终状态与按 seq 排序去重的规范重放逐一 `deepEqual` 对照。

真实进程退出码（shell 直接执行 `node cli.js` 验证）：

```
单调性破坏   exit=11   (stderr: monotonicity violation: wear regression on T1: 50 -> 40 (seq 2))
预算超限     exit=5
示例正常流程 exit=0
缺参数       exit=2
```
