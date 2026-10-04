# lakeql

单机离线、仅 Node.js 22 标准库的分组聚合查询引擎与优化器，附带可验证的等价证书。

## 功能

- 逻辑计划：`select / project / join(inner) / groupby(+having)`
- 物理算子：`seqscan / filter / project / hashjoin / nljoin / hashagg`
- SQL 三值逻辑：NULL 连接键不连接；聚合忽略 NULL；HAVING 输出
  true/false/unknown，unknown 分组进入 `unknownRows` 而非静默丢弃
- 优化规则（保留 NULL 与重复语义）：
  - `predicate_pushdown` 谓词下推（合取拆分，单边下推，双边并入连接条件）
  - `projection_pruning` 投影裁剪（不引入 DISTINCT，保袋语义）
  - `aggregate_pushdown` 聚合下推（仅在数据上验证：对侧连接键非 NULL 唯一、
    本侧键无 NULL 且全部存在于对侧时触发，否则拒绝改写）
- 每次优化输出等价证书：改写规则序列、抽样行哈希、≤300 行全量对照哈希；
  优化结果与直接枚举不一致时抛 `E_NON_EQUIV`，绝不返回近似结果
- 代价模型枚举物理计划，并列最低代价计划全部报告

## 用法

```sh
node src/cli.js sql <file.sql> [--data dir]        # 执行（含证书）
node src/cli.js explain <file.sql> [--data dir] [--json]
node src/cli.js verify <planA.sql|json> <planB.sql|json> [--data dir]
node src/cli.js bench --rows N                     # hash vs nested loop
node --test                                        # 全部测试
```

数据目录中每个 `<table>.json` 是一个行对象数组。示例见 `examples/`。

## 错误码

- `E_PARSE` 语法/词法/未知列或表
- `E_TYPE` 类型错误（如字符串与数值比较、非布尔 WHERE、SUM 非数值）
- `E_NON_EQUIV` 计划不等价（错误改写被拒绝）
- `E_UNSUPPORTED` 超出子集的语法（DISTINCT、外连接、子查询、ORDER BY 等）

## 验收对照

1. ≤300 行与直接枚举一致：`test/equiv.test.js`（多随机种子 × 多查询模板，
   证书 mode=full）
2. NULL/unknown 边界：`test/exec.test.js`、`test/equiv.test.js`
3. 并列最低代价全部报告：`test/optimize.test.js`（2×2 连接 hash/nested 并列）
4. 错误改写拒绝而非近似：`test/cli.test.js`（篡改计划 JSON → E_NON_EQUIV）
