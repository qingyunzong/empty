# offline-query-engine

离线 JSON 查询引擎：对 JSON 表执行**投影、过滤、内连接、分组聚合**，遵循
SQL 三值逻辑（3VL），整数全程精确（BigInt）。仅使用 TypeScript + Node.js
内置模块，零运行时依赖。

## 语义约定

- **三值逻辑**：任何涉及 `NULL` 的比较结果为 UNKNOWN；`WHERE` / `JOIN ... ON`
  只保留条件为 TRUE 的行。`AND`/`OR`/`NOT` 遵循 SQL 真值表。
- **COUNT**：`count("*")` 统计组内全部行；`count(expr)` 忽略 NULL。
  `sum`/`avg`/`min`/`max` 同样忽略 NULL；空集上 `count` 为 0，其余为 NULL。
- **整数精确**：JSON 整数字面量解析为 BigInt（利用 `JSON.parse` reviver 的
  `context.source`），`+`/`-`/`*`、`sum`、`count` 全程精确；`avg` 在整除时
  返回精确整数，否则返回浮点。浮点字面量（如 `1.5`）保持为 number。
- **确定排序**：输出按全部输出列升序排序，全序为
  `NULL < false < true < 数值 < 字符串`（码元序），与输入行序无关。
- **对照验证**：主引擎（哈希连接 + 哈希分组）与独立的嵌套循环解释器
  （`src/reference.ts`）在随机微小表上交叉比对，结果必须完全一致。

## 使用

```sh
npm test          # 编译 (tsc) 并运行全部测试
npm run query -- examples/db.json examples/query.json            # 主引擎
npm run query -- examples/db.json examples/query.json --reference # 对照解释器
```

数据库文件：`{"tables": {"表名": [{"列": 值, ...}, ...]}}`。查询文件示例见
`examples/query.json`：

```json
{
  "from": "emp",
  "joins": [{ "table": "dept", "on": { "op": "=", "left": { "col": "emp.dept_id" }, "right": { "col": "dept.id" } } }],
  "where": { "op": ">", "left": { "col": "emp.sal" }, "right": { "lit": 100 } },
  "groupBy": ["dept.dname"],
  "select": [
    { "col": "dept.dname", "as": "dept" },
    { "agg": "count", "arg": "*", "as": "heads" },
    { "agg": "sum", "arg": { "col": "emp.sal" }, "as": "total_sal" }
  ]
}
```

表达式：`{"col": "t.c"}`、`{"lit": 值}`、`{"op": "=|<>|<|<=|>|>=|+|-|*",
"left": …, "right": …}`、`{"op": "and|or", "args": […]}`、
`{"op": "not", "arg": …}`、`{"op": "isnull", "arg": …}`。
聚合：`count`（支持 `"*"`）、`sum`、`avg`、`min`、`max`。

示例输出（两引擎一致；超大整数序列化为字符串以保持精度）：

```json
[
  { "dept": "eng", "heads": 2, "paid": 1, "total_sal": "9007199254740993", "avg_sal": "9007199254740993" },
  { "dept": "ops", "heads": 1, "paid": 1, "total_sal": 120, "avg_sal": 120 }
]
```

## 结构

- `src/values.ts` — 值模型、精确 JSON 解析、全序比较、确定性序列化
- `src/expr.ts` — 表达式 AST、列解析、三值逻辑求值
- `src/query.ts` — 查询 JSON 解析与校验
- `src/engine.ts` — 主引擎：哈希连接（无等值条件时回退嵌套循环）+ 哈希分组
- `src/reference.ts` — 对照解释器：纯嵌套循环连接 + 线性扫描分组
- `src/cli.ts` — 命令行入口
- `test/engine.test.ts` — 13 项有向语义测试
- `test/crosscheck.test.ts` — 500 组随机微小表/查询的双引擎交叉验证
- `types/node-shims.d.ts` — 离线环境的最小 Node 类型声明（仅编译期）

## 实际测试结果

环境：Node.js v22.22.1，tsc 5.x（全局），2026-10-06 运行 `npm test`
（`tsc -p tsconfig.json && node --test "dist/test/*.test.js"`）：

```
ok 1 - projection and filter: WHERE keeps only TRUE
ok 2 - NULL comparison is UNKNOWN; IS NULL recovers those rows
ok 3 - three-valued AND / OR / NOT
ok 4 - inner join drops NULL join keys
ok 5 - COUNT(column) ignores NULLs; SUM/AVG/MIN/MAX ignore NULLs
ok 6 - aggregates over the empty set: COUNT = 0, others NULL
ok 7 - integers are exact beyond 2^53 (BigInt end to end)
ok 8 - JSON parsing: integer literals become bigint, floats stay floats
ok 9 - AVG is exact when the integer quotient is integral
ok 10 - output order is deterministic regardless of input row order
ok 11 - arithmetic in expressions, with NULL propagation
ok 12 - main engine and reference interpreter agree on directed cases
ok 13 - errors: unknown table, ambiguous column, non-grouped select
ok 1 - cross-check main engine vs nested-loop reference on tiny random inputs

# tests 2   # pass 2   # fail 0   （共 14 个子测试全部通过）
```
