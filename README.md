# rostersolve

离散时间可行性调度器：带资源（cpu/mem）、依赖、标签亲和与截止期的
回溯搜索求解器，只使用 Python 标准库（兼容 Python 3.11+）。

## 用法

```bash
python -m rostersolve plan jobs.json --out plan.json --trace trace.json
```

（本仓库环境只有 `python3` 命令；`python` 指向解释器时命令相同。）
省略 `--out` 时结果写到 stdout；省略 `--trace` 时不生成 trace。

## 输入格式

```json
{
  "horizon": 6,
  "jobs": [
    {"id": "j1", "cpu": 2, "mem": 1, "deadline": 6,
     "duration": 2, "deps": [], "tags": []}
  ],
  "machines": [
    {"id": "m1", "cpu": 2, "mem": 2, "tags": []}
  ]
}
```

- 必填字段：job 的 `id/cpu/mem/deadline/duration`，machine 的
  `id/cpu/mem`，顶层 `jobs/machines/horizon`。
- `deps` 与 `tags` 可省略，默认为 `[]`。
- `duration >= 1`；`cpu/mem/deadline/horizon >= 0`。

## 语义

1. 时间片为 `0..horizon-1`，同一机器每片 cpu/mem 占用总和不得超过容量。
2. job 仅在全部 deps 完成后才可启动；启动后不可迁移、不可抢占，
   长度固定为 `duration`，且须满足 `start + duration <= deadline`。
3. 机器的 `tags` 必须包含 job 的全部 `tags`。
4. 存在可行解时输出每台机器每片的 `job_id` 或 `null` 以及 `makespan`；
   否则输出 `INFEASIBLE` 及包含极小的冲突 job 子集（按 id 升序逐个
   尝试删除、仍不可行则剔除的贪心包含极小子集）。
5. 同解时按 job id 字典序（拓扑序）、机器 id、时间片升序取首个解，
   输出完全确定。

## 输出

可行：

```json
{"status": "FEASIBLE", "makespan": 4, "horizon": 6,
 "schedule": {"m1": ["j1", "j1", "j2", "j2", null, null]}}
```

不可行：

```json
{"status": "INFEASIBLE", "conflict": ["j1"]}
```

trace 文件包含输入的 SHA-256、搜索节点数与放置/回溯事件，
同一输入多次运行字节完全一致。

## 错误

JSON 非法、字段缺失、环依赖、负资源、未知依赖等输入错误：
退出码 `2`，stderr 单行 JSON，例如：

```
{"error": "job 'j1': negative resource requirement"}
```

`INFEASIBLE` 是正常求解结果，退出码为 `0`。

## 测试

```bash
python -m unittest discover -s tests -v
python -m rostersolve plan examples/a.json --out /tmp/a.json --trace /tmp/t.json
```

测试覆盖：A 依赖链与单机容量边界；B 标签不匹配 INFEASIBLE 且冲突
子集非空；C n<=8、horizon<=12 的 60 个随机小例与库内暴力枚举
（`rostersolve/brute.py`）对照可行性一致；D 同一输入连续 5 次运行
trace 字节相同；另有输入错误处理测试。

### 真实运行记录（2026-10-01，Python 3.14.4）

`python3 -m unittest discover -s tests -v`：

```
Ran 16 tests in 5.562s

OK
```

退出码 `0`。

`python3 -m rostersolve plan examples/a.json --out /tmp/a.json --trace /tmp/t.json`：
退出码 `0`，`/tmp/a.json` 为 `status=FEASIBLE`、`makespan=4`，
`schedule.m1 = ["j1","j1","j2","j2",null,null]`。
