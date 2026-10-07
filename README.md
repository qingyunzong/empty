# offline-scheduler

确定性双设备离线排程库 + 单机 JSON CLI。Node.js 22，仅标准库，测试使用 `node:test`。

## 问题定义

- 至多 20 个工单（job），两台设备（device，默认 `M1`/`M2`）。
- 每个工单：`id`、`release`（到达时间）、`due`（交期）、`duration`（加工时长，>0）、可选 `devices`（可用设备子集，缺省为全部）。
- 每台设备可选 `capacity`（可用时间上限，所有工序必须在该时刻前完成；缺省不限）。
- 目标：最小化最大延期 `Lmax = max(C_j - due_j)`。
- 平局判定（全序，确定性）：
  1. `Lmax` 升序；
  2. 设备分配元组（工单按 id 排序后各工单设备下标）字典序；
  3. 设备 0 的 `(lmax, makespan)`，再设备 1 的 `(lmax, makespan)`；
  4. 设备 0 的工单序列、再设备 1 的工单序列，按规范下标字典序。

## 算法（`src/scheduler.js`）

- 每台设备做子集 Pareto DP：`frontier[mask]` 保存非支配 `(makespan, lmax)` 点（对 `1|r_j|Lmax` 精确）。
- 枚举 2^n 种设备分配，取 `max(l0, l1)` 最小者；平局按分配元组字典序。
- 序列的字典序最小化由独立的记忆化可行性 DP 提取（`extractSequence`）：Pareto 剪枝会丢弃"被支配但经 release 钳制后最终 (t,l) 相同、序列字典序更小"的前缀，因此不能在 DP 内直接传播序列。
- 证书：`{algorithm, inputHash, objective, tieCount, tieRank}`。`inputHash` 为规范化输入（工单/设备排序后）的 SHA-256；`tieCount` 为达到最优目标值的分配方案数；`tieRank` 为所选分配在平局分配中的字典序名次（恒为 1，因为规则即取最小者）。
- 不可行时抛 `E_INFEASIBLE`，`details.jobId` 为首个不可安排工单：优先为无可用设备或单机都放不下的工单（按 id 序首个）；若仅聚合容量不足，则为规范序首个工单。

## 存储（`src/store.js`）

- 目录结构：`wal.log`（JSON 行，仅追加，写后 fsync）、`versions/v-N.json`、`meta.json`、`jobs.json`、`index.json`。
- 事务：`beginPlan()` 记录 `baseJobsVersion` 与工单哈希 → `stage()` 将完整计划写入 WAL（崩溃点 `after_stage`）→ `commit()` 校验工单集仍是快照版本（否则 `E_SNAPSHOT`），写 commit 标记（崩溃点 `after_commit`），再落版本文件并重建索引。
- 恢复：重放 WAL；最后一个 commit 标记对应的暂存计划成为可见版本（版本文件缺失则从 WAL 物化）；无 commit 标记的暂存记录丢弃；末尾撕裂行忽略。
- 二级索引 `(jobId, deviceId)`：指向当前可见版本中的 `{version, start, end, position}`，每次提交/恢复后重建并持久化到 `index.json`。
- 不可行在暂存之前抛出，失败重排不会触碰已提交的旧计划。

## CLI（`cli.js`，JSON 输入输出）

```
node cli.js set-jobs --db DIR --file jobs.json   # 或从 stdin 读
node cli.js plan --db DIR                        # 求解+暂存+提交
node cli.js current --db DIR
node cli.js jobs --db DIR
node cli.js lookup --db DIR --job J2 --device M1
node cli.js verify --db DIR                      # 与独立 DFS 穷举交叉校验（<=8 工单）
node cli.js recover --db DIR
SCHED_CRASH=after_stage|after_commit node cli.js plan --db DIR   # 崩溃注入，退出码 99
```

退出码：0 成功；2 `E_INFEASIBLE`；3 `E_SNAPSHOT`；4 `E_INVALID`；5 `E_CORRUPT`；6 `E_UNSUPPORTED`。

## 测试

```
node --test
```

- `test/scheduler.test.js`：300 个随机 ≤4 工单实例与独立 DFS 穷举（`src/verify.js`，枚举全部排列×设备选择）逐字段一致；证书字段；`E_INFEASIBLE`/`E_INVALID`；20 工单规模与确定性。
- `test/store.test.js`：版本可见性、快照冲突（含重放）、`after_stage`/`after_commit` 崩溃恢复、不可行不覆盖旧计划、撕裂 WAL。
- `test/cli.test.js`：CLI 端到端、崩溃注入边界、JSON 错误输出、stdin 输入。
