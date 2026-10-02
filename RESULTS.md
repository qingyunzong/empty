# RESULTS

- 环境：Node.js v22.22.1，仅标准库，单机离线
- 命令：`node --test`
- 记录时间（UTC）：2026-10-02T21:39:24Z

## 汇总（真实输出）

```
✔ test/cli.test.js
✔ test/engine.test.js
✔ test/solver.test.js
tests 3 files / 16 tests
pass 16
fail 0
```

## 用例明细（全部通过）

### test/solver.test.js
- acceptance 3: <=6 carriers, solver matches brute-force optimum, ties and budget —— 6 载具 3 机台，与独立暴力枚举对照目标值、并列解集合与预算占用
- acceptance 4: identical score/due/lot carriers produce every tied solution —— 同事件同分并列，2 个最优解全部输出，canonical 按 (due, lot, carrier) 取 C1
- window join excludes out-of-window carriers —— 区间联结窗口外不可派
- negative scores are left unassigned —— 负分不派，目标值不为负

### test/engine.test.js
- acceptance 1: late metro rewrites priority and triggers a better replan —— 计量迟到（eventTs 早于水位线）回写优先级，目标值 10 → 1000 的更优重排，late.log 与 rework.jsonl 均有记录
- acceptance 2: tool window retract cascades migration, never negative remaining —— 撤回 T1 后 C1→T2、C2→T3、C3 下线的级联迁移，预算剩余无负值
- metro retract releases locked budget and replans —— 计量撤回释放已锁预算（budget_release, releasedQty=5）
- metro for unknown lot goes to pending without failing, resolves on arrival —— 未知 lot 计量进 pending 不失败，载具到达后自动生效
- cap < 0 reports CAP_INVALID
- unknown event kind and bad op are rejected —— KIND_INVALID / INVALID_OP
- finalize outputs: watermark, ties, unassigned, budget totals —— 水位线 = 最大事件时间 − 5 分钟，并列计数与预算总量

### test/cli.test.js
- CLI solve writes plan.json, budget.json, rework.jsonl, late.log —— 四个产物齐全，内容正确
- CLI: late metro recorded in late.log and rework.jsonl
- CLI: cap < 0 exits non-zero with CAP_INVALID —— main() 返回退出码 2，stderr 含 CAP_INVALID
- CLI: usage error without args —— 退出码 64
- CLI: multiple jsonl files in --in dir are merged in name order

## 备注

- 沙箱禁止 spawn 子进程，CLI 测试在进程内调用 `run()`/`main()` 验证（含退出码与 stderr）。
- 并列最优枚举上限 `maxTies=1000`、搜索节点上限 `maxNodes=5e6`，超限置 `tiesTruncated`。
