# miniquery

离线 JSON 查询库（TypeScript，仅 Node.js 内置库，零运行时依赖）。
支持投影、过滤（WHERE）、内连接（INNER JOIN）与分组聚合（GROUP BY）。

## 运行

```bash
npm test          # tsc 编译 + node --test（需要全局或本地 tsc）
npm run cli -- examples/example.json   # 或: node dist/src/cli.js < input.json
```

## 输入

CLI 读取一个 JSON 对象：`{ "tables": { 名: { "columns"?: [...], "rows": [...] } }, "query": {...} }`。
JSON 整数被精确解析为 bigint（利用 `JSON.parse` 的 source reviver），
超过 2^53 的整数在输出中序列化为十进制字符串。

## 查询格式

```jsonc
{
  "from": { "table": "users", "as": "u" },
  "joins": [ { "table": "orders", "as": "o", "on": <expr> } ],   // 内连接，可多个
  "where": <expr>,                                              // 只保留 TRUE
  "groupBy": ["u.name"],
  "select": [
    { "col": "u.name", "as": "name" },
    { "agg": { "fn": "count", "arg": "*" }, "as": "n" },        // count/sum/min/max/avg
    { "agg": { "fn": "sum", "arg": "o.amt" } }
  ]
}
```

表达式：`<expr>` 为 `{col}` / `{lit}` / `{op:"eq|ne|lt|le|gt|ge", args:[a,b]}` /
`{op:"and|or", args:[...]}` / `{op:"not", arg}` / `{op:"isNull|isNotNull", arg}`。

## 语义

- **三值逻辑**：任何与 NULL 的比较结果为 UNKNOWN；`WHERE`/`ON` 只保留 TRUE。
  `NOT UNKNOWN = UNKNOWN`。`IS NULL` / `IS NOT NULL` 用于显式判空。
- **COUNT**：`count(*)` 计行数；`count(col)` 忽略 NULL。`sum/min/max/avg` 同样忽略 NULL，
  全 NULL 时结果为 NULL。
- **整数精确**：整数以 bigint 运算，求和/计数不丢精度；`avg` 返回浮点数。
- **分组**：NULL 键归为一组；无 `groupBy` 的聚合把全表（含空表）视为一组。
- **确定排序**：输出按 select 列从左到右排序（NULL < 数值 < 字符串 < 布尔），
  与输入行序无关。
- 类型规则：数值（整数/浮点）可互相比较；跨类型比较中 `=`/`<>` 返回 FALSE/TRUE，
  大小比较抛出 `QueryError`；未知名/歧义列名抛出 `QueryError`。

## 架构与正确性对照

- `src/engine.ts`：主执行器——谓词下推、等值条件哈希连接、哈希分组。
- `src/reference.ts`：对照解释器——纯嵌套循环连接、无下推、线性扫描分组。
- `test/differential.test.ts`：固定种子随机生成 2000 组小表与查询，
  逐例断言两个执行器输出完全一致。
- 其余测试覆盖三值逻辑真值表、NULL 聚合、空表、超 2^53 精确整数、
  连接语义与输出确定性（打乱输入行序结果不变）。

实际测试结果见 `TEST_RESULTS.md`。
