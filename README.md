# 污水站加药泵离线调度器

单机离线运行，Node.js 22，仅标准库。按离线计划执行加药，掉电后可恢复且绝不重复投药。

## 用法

```bash
node cli.js exec --plan plan.json --journal j --out out   # 执行计划
node cli.js recover --journal j                           # 掉电恢复
node cli.js modify-plan --journal j --plan newplan.json   # 计划更正
node cli.js compensate --journal j --pump PAC-1 --slot 3  # 手动负向补偿
```

`--pumps` 可显式指定泵清单，缺省取 plan 同目录的 `pumps.json`。

## 输入

- `plan.json`：`{ "doses": [{ "pump_id", "slot", "dose", "start"?, "end"? }] }`
- `pumps.json`：`{ "pumps": [{ "pump_id", "max_dose" }] }`
- journal 目录：执行时写入 `journal.jsonl`（intent/effect/checkpoint 事件）、
  `plan.json`/`pumps.json` 快照与 `meta.json`（记录 out 路径，供 recover 使用）。

## 输出

- `<out>/dose_ledger.jsonl`：剂量台账（`dose` 正向记录 + `compensate` 负向记录）。
- `<journal>/recovered.json`：恢复报告（`replayed` / `checkpoint_only` / `executed` / 总量）。
- `<journal>/modify_result.json`：更正结果（`applied` / `rejected` / `compensations`）。

## 核心机制

1. **幂等键**：剂量命令以 `pump_id + slot` 为幂等键，写入台账前去重，重复 effect 不累计。
2. **两类故障点**（每步顺序为 intent → effect → checkpoint）：
   - intent 后、effect 前：恢复时**重放**该步（`replayed`）；
   - effect 后、checkpoint 前：恢复时**只补 checkpoint**（`checkpoint_only`），台账写入幂等，不会重复投药。
3. **计划更正**：`modify-plan` 只影响未锁槽位；已投槽位的修改/删除被列入
   `rejected` 并说明原因，同时生成负向 `compensate` 记录，历史不删除。

## 错误码

- `exit=2`：未知泵、负剂量、槽位重叠（同泵同槽重复或时间窗重叠）、参数错误。
- `exit=1`：其他运行错误（如 journal 非空时重复 exec）。

## 测试与验收

```bash
node --test            # 全部测试
bash scripts/acceptance.sh   # 两故障点 kill 进程演示
```

测试注入方式：环境变量 `DOSE_CRASH_AFTER=intent|effect`、`DOSE_CRASH_SEQ=n`，
进程在对应故障点 `SIGKILL` 自杀，模拟掉电。

验收覆盖：

1. `test/crash.test.js`：两故障点 kill 进程，恢复后总剂量与无故障参考一致；
2. `test/exec.test.js`：重复提交同一 slot（台账层 + 重复 recover）不增量；
3. `test/modify.test.js`：modify_plan 跨已投槽位时部分拒绝并列明，负向补偿；
4. `test/crash.test.js`：8 槽位 × 2 故障点共 16 种崩溃序列，逐一对照参考结果。

最近一次真实运行结果：`node --test` → 4 个测试文件全部通过；展开计 **tests 28, pass 28, fail 0**
（exec 7 + crash 18 + modify 3，含 16 个崩溃序列子测试）。
