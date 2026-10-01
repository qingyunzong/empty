# rostersolve

离散时间作业排程求解器：在固定时间片 `0..horizon-1` 上，把作业分配到机器，
满足资源容量、依赖、标签亲和与截止期约束。求解采用**完备回溯搜索**——
只要存在可行解就一定能找到，绝不会把"未决"误判为"不可满足"。
仅使用 Python 3.11 标准库。

## 用法

```
python -m rostersolve plan jobs.json --out plan.json --trace trace.json
```

- `jobs.json`：输入文件（见下文格式）。
- `--out`：可选，计划输出路径；省略时写到 stdout。
- `--trace`：可选，确定性搜索轨迹输出路径。

退出码：`0` = 正常完成（无论 FEASIBLE 还是 INFEASIBLE）；`2` = 输入错误
（JSON 非法 / 字段缺失 / 环依赖 / 负资源 / 未知依赖等），此时 stderr 输出
单行 `{"error": ...}`。

## 输入格式

```json
{
  "horizon": 6,
  "jobs": [
    {"id": "j1", "cpu": 2, "mem": 1, "duration": 2, "deadline": 6,
     "deps": [], "tags": []}
  ],
  "machines": [
    {"id": "m1", "cpu": 2, "mem": 1, "tags": []}
  ]
}
```

- `id`：字符串或整数；`cpu`/`mem` 为非负整数；`duration >= 1`；
  `deadline` 为整数或 `null`（`null` 表示取 `horizon`）。
- 语义：作业 `j` 占据启动时刻起的 `duration` 个连续时间片，不可迁移、
  不可抢占；全部 `deps` 完成后才能启动；须满足 `start + duration <= deadline`；
  机器 `tags` 必须包含作业的全部 `tags`；同一机器同一时间片上
  cpu/mem 总和不得超过容量。

## 输出格式

可行时（`makespan` 为最晚完成时刻，每台机器给出每个时间片的 job_id 或 null）：

```json
{"status": "FEASIBLE", "makespan": 4, "horizon": 6,
 "machines": [{"id": "m1", "slots": ["j1", "j1", "j2", "j2", null, null]}]}
```

不可行时给出最小冲突子集（删除极小化的不可满足作业子集）：

```json
{"status": "INFEASIBLE", "conflict": ["needs-gpu"]}
```

多重解时输出是确定性的：作业按 id 字典序的拓扑序依次放置，
机器按 id 升序、起始时间片升序取第一个可行位置。同一输入的
plan 与 trace 输出字节级一致（测试 D 验证连续 5 次运行相同）。

## 项目结构

- `rostersolve/model.py` — JSON 解析与校验（`InputError` → 退出码 2）
- `rostersolve/solver.py` — 完备回溯求解器、计划构造、最小冲突子集
- `rostersolve/brute.py` — 独立实现的暴力枚举可行性判定（测试对照用）
- `rostersolve/cli.py` / `__main__.py` — 命令行入口
- `tests/` — 验收测试 A/B/C/D 与错误处理测试
- `examples/a.json` — 验收 A 示例（两作业依赖链 + 单机容量边界）

## 测试

```
python -m unittest discover -s tests -v
python -m rostersolve plan examples/a.json --out /tmp/a.json --trace /tmp/t.json
```

真实运行结果（2026-10-01，Python 3.14.4）：

```
$ python -m unittest discover -s tests -v
test_chain_respects_dependency_and_capacity ... ok
test_capacity_boundary_one_less_is_infeasible ... ok
test_example_a_via_cli ... ok
test_tag_mismatch_infeasible_with_conflict ... ok
test_tag_mismatch_via_cli ... ok
test_random_cases_match_brute_force ... ok      # 300 个随机小例与暴力枚举一致
test_trace_is_byte_identical_across_runs ... ok  # 连续 5 次 trace/plan 字节相同
test_cyclic_dependency ... ok
test_invalid_json ... ok
test_missing_job_field ... ok
test_missing_top_level_field ... ok
test_negative_resources ... ok
test_unknown_dependency ... ok

----------------------------------------------------------------------
Ran 13 tests in 6.071s

OK
退出码: 0
```

```
$ python -m rostersolve plan examples/a.json --out /tmp/a.json --trace /tmp/t.json
退出码: 0
# /tmp/a.json: status=FEASIBLE, makespan=4, m1 slots=["j1","j1","j2","j2",null,null]
```
