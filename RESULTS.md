# RESULTS

日期: 2026-10-03 00:39:46 CST
环境: v22.22.1, Linux x86_64, 仅标准库

## 命令

```sh
node --test
```

## 结果（真实运行输出）

```
✔ test/cli.test.js (1806.198714ms)
✔ test/engine.test.js (2071.105598ms)
ℹ tests 2
ℹ suites 0
ℹ pass 2
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 2496.049544
exit=0
```

## 测试清单（12 个用例，全过）

- test/engine.test.js
  - acceptance 3: 磨损顺序枚举对照（wear 1/4/0.5/0，累计 1/5/5.5/5.5）
  - acceptance 4: 恰好磨损到 0 不算 EXHAUST，再磨一点才超额
  - acceptance 2: 撤回 load 回滚磨损、恢复刀具段与零件风险
  - acceptance 1: 迟到 qc（eventTs 低于水位线）把 P1 拉 BAD、P2/P3 升 RISK，撤回后全链恢复
  - qc 撤回 GOOD→UNKNOWN 并重算同刀后续风险
  - 同 part 多 qc：最新 eventTs 优先，平手取 op id 字典序最大
  - change 开新段；newLife<=0 报 LIFE_INVALID 并跳过
  - 无寿命段的 load 记 untracked；撤回不存在的事件报 RETRACT_MISS
  - parseJsonl 收集 PARSE_ERROR / EVENT_INVALID
- test/cli.test.js
  - 端到端：生成 tools.jsonl/parts.jsonl/risk.json/late.log，迟到 qc 改链，LIFE_INVALID 上报
  - 输入流撤回 load 恢复刀具段
  - 缺 --in/--out 退出码 2 并打印 usage
