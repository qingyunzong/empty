# 维修工单排程器（Node.js 22 标准库，离线）

库：`src/planner.js`（`Planner` 类）；CLI：`cli.js`（JSONL 逐行命令，参数为文件路径或 stdin）。

## JSONL 命令

```json
{"op":"add_task","id":"a","dur":3,"cost":10}
{"op":"dep","a":"a","b":"b"}        // a 必须先于 b
{"op":"group_begin"}               // 开启一层分组（可嵌套，层级从 1 起）
{"op":"group_end"}                 // 关闭当前分组，进入历史
{"op":"commit"}                    // 提交所有已关闭分组（置 committed 标记）
{"op":"rollback","level":1}        // 撤销 level > 1 的所有分组（含已提交标记）
{"op":"schedule","budget":100}
```

每行输出一个 JSON：`add_task/dep/group_*/commit` 返回 `{"status":"OK"}` 或
`{"status":"INVALID_INPUT","error":...}`；`rollback` 越界（level 非整数、<0 或大于当前最大层级）
返回 `{"status":"ROLLBACK_RANGE"}` 且状态不变。

## schedule 语义

- 资源无限、单预算约束：所有工单 ASAP 并行，`start = max(前驱 end)`，`end = start + dur`，
  `makespan` 为关键路径长度；`total_cost` 为全部工单成本之和。
- `total_cost > budget` → `{"status":"INFEASIBLE","total_cost":N,"budget":M}`，绝不丢任务。
- 存在环（含自环）→ `{"status":"CYCLE","sccs":[[...]],"break_suggestions":[...]}`：
  所有含环强连通分量（id 字典序），可断边建议为环内每条依赖边，
  成本取边的前驱（源）工单成本，按成本升序、再按边字典序排列。
- 正常 → `{"status":"OK","order":[...],"start":{...},"end":{...},"makespan":N,"total_cost":N,"budget":M}`。
  `order` 排序键：`start` 升序 → 时长降序（同层多解按总时长）→ 工单 id 字典序。
- 非法输入（重复 id、未知工单、负时长/成本、负预算、未配对的 group_end 等）→ `INVALID_INPUT`。

## 分组与回滚

- `group_begin/group_end` 嵌套形成层级；组内 `add_task/dep` 记录在该组。
- `commit` 给所有已关闭分组打上 committed 标记。
- `rollback(level)` 撤销所有层级 > level 的分组：移除其新增工单与依赖、清除其 committed 标记；
  层级 ≤ level 的分组（含 committed 标记）保持不变。被删工单上的外部依赖一并清理。

## 规模与限制

任务 ≤ 250、依赖 ≤ 2000（超限返回 INVALID_INPUT）。SCC 用 Tarjan，排程为 Kahn 拓扑 + 最长路径。

## 运行

```sh
node cli.js input.jsonl     # 或 cat input.jsonl | node cli.js
node --test                 # 运行全部测试
```
