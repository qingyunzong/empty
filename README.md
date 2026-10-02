# dose-planner

污水站加药泵离线排程与断点恢复。Node.js 22，仅标准库，测试用 `node:test`，单机离线。

## 用法

```sh
node cli.js exec        --plan plan.json [--pumps pumps.json] --journal j --out out
node cli.js recover     --journal j
node cli.js modify-plan --journal j --plan newplan.json
node cli.js compensate  --journal j --pump p1 --slot s3 --dose 20
node --test
```

- `plan.json`: `{"doses":[{"pump_id":"p1","slot":"s0","dose":10}, ...]}`；slot 也可是 `{"start":0,"end":10}` 区间。
- `pumps.json`: `{"pumps":[{"pump_id":"p1"}, ...]}`（缺省取 plan 同目录的 `pumps.json`）。
- 输出：`out/dose_ledger.jsonl`（同时 journal 内保留权威副本）、`j/recovered.json`、`j/modify_plan_result.json`。

## 核心机制

**每步三段写入**（journal 目录下 `intents/ effects/ checkpoints/`，均为写临时文件 + fsync + rename）：

1. **intent**：步骤意图（含 pump_id、slot、dose）。
2. **effect**：向 `dose_ledger.jsonl` 追加剂量记录并写 effect 标记。
3. **checkpoint**：步骤完成标记。

**幂等键** = `pump_id + slot`。写 effect 前先读 ledger 已有键，重复不追加；已 checkpoint 的步骤整体跳过，重复提交同一 slot 不增量。

**两类故障点与恢复**（`node cli.js recover --journal j`）：

- intent 已写、effect 缺失 → **重放**该步（补 effect + checkpoint）。
- effect 已写、checkpoint 缺失 → **只补 checkpoint**，不重放、不重复投药。

**计划更正**：

- `modify-plan` 只作用于未锁槽位（未投药）；触及已投槽位的增/删/改被**部分拒绝**并在 `modify_plan_result.json` 的 `rejected` 列表列明（含原因 `slot_locked_already_dosed`），其余变更照常应用。
- 已投槽位的更正用 `compensate`：向 ledger 追加 `type:"compensate"` 的**负向记录**，原始记录保留不删除。

**校验错误（exit=2）**：未知泵 `UNKNOWN_PUMP`、负剂量 `NEGATIVE_DOSE`、槽位重叠 `SLOT_OVERLAP`（同泵 slot 重名或区间相交）。其它错误 exit=1。

**故障注入**（验收用）：环境变量 `DOSE_CRASH_AT="<step>:<intent|effect>"`，在对应写入点后对自身发 `SIGKILL` 模拟掉电。

## 验收测试（test/acceptance.test.js）

1. 在两个故障点 kill 进程，恢复并完成执行后，总剂量与 ledger 内容同无故障参考一致。
2. 同一计划重复 exec 三次，ledger 不增量。
3. 部分投药后 `modify-plan` 跨已投槽位：已投槽位拒绝并列明、未锁槽位应用；`compensate` 生成负向记录且原记录保留。
4. 8 槽位 × 2 故障点共 16 种崩溃序列，逐一恢复+续跑后与参考 ledger 完全一致。
5. 未知泵 / 负剂量 / 槽位重叠（重名与区间两种）均 exit=2。

## 真实测试记录（2026-10-03，node v22.22.1）

```
$ node --test
# tests 1        # 文件级
# pass 1
# fail 0
# duration_ms 85436.45953

$ node test/acceptance.test.js   # 子测试明细
ok 1 - acceptance 1: crash at intent/effect fault points recovers to reference total
ok 2 - acceptance 2: re-executing the same plan does not double-dose
ok 3 - acceptance 3: modify_plan rejects dosed slots, applies unlocked, compensate adds negative record
ok 4 - acceptance 4: 8-slot crash enumeration converges to reference ledger
ok 5 - validation: unknown pump, negative dose, slot overlap all exit with code 2
# tests 5
# pass 5
# fail 0
```

注：本沙箱环境中子进程 stdout/stderr 捕获不可用（spawnSync 返回伪 EPERM，但进程实际执行、退出码与文件写入正常），因此 CLI 结果均持久化到 journal 文件，测试从磁盘断言。
