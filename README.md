# lakeq

单机离线查询优化器实验台：Node.js 22、仅标准库、`node:test`。针对科学数据湖的
"带筛选的分组聚合" 查询，在等价改写间做基于代价的选择，并为每次优化输出可验证的
等价证书。

## 功能

- **逻辑计划**：`scan → join → select(where) → groupby(+having) → project`
- **物理算子**：`seqscan` / `filter` / `project` / `hashjoin` / `nestedjoin` /
  `hashagg` / `partagg` / `finalagg`，基于实际基数的代价模型枚举全部物理计划，
  **并列最低代价的计划全部报告**（`tiedBestPlans` / `chosen` 标记）
- **三值逻辑**：NULL 连接键不连接；聚合忽略 NULL（全 NULL 时 SUM/AVG/MIN/MAX 为
  NULL，COUNT 为 0）；HAVING 输出 true/false/unknown，**unknown 行进入结果顶层
  的 `unknown` 桶，绝不静默丢弃**，且计入等价哈希
- **优化规则**（保留 NULL 与重复语义）：
  - `predicate_pushdown`：仅拆分顶层 AND 合取项（OR/NOT 内部不动，保证三值语义），
    单侧谓词下推到 join 之下；HAVING 中仅引用分组键的合取项下推到聚合之下
  - `projection_pruning`：只裁剪下游不可达列，连接键/谓词/分组键/聚合参数保留，
    不去重
  - `aggregate_pushdown`：可分解聚合（COUNT/SUM/MIN/MAX/AVG）改写为
    partial→final 两阶段，部分状态携带非 NULL 计数以保持 NULL 语义
- **等价证书**：每次优化输出
  - `rules`：改写规则序列及可校验参数（谓词、目标子树模式等）
  - `inputs`：每张表的确定性抽样行哈希（stride 抽样 ≤32 行）
  - `fullCheck`：输入总量 ≤300 行时，优化计划 vs 直接枚举的**全量结果哈希对照**
    （含 unknown 桶）
- **verify**：对两个计划（`.sql` 或 `explain --out` 生成的 `.json`）做
  ① 证书规则前置条件结构化校验 ② 全量结果多重集哈希精确对照。
  **错误改写一律拒绝（E_NON_EQUIV），绝不给近似答案**

## CLI

```sh
node bin/cli.js sql <file.sql> [--data DIR]                          # 执行并输出 rows/unknown/证书
node bin/cli.js explain <file.sql> [--data DIR] [--stage logical|optimized] [--out plan.json]
node bin/cli.js verify <planA> <planB> [--data DIR]                  # 等价性证明
node bin/cli.js bench --rows N                                       # 直接枚举 vs 优化执行
```

表数据为 `data/<table>.json`（行对象数组，值仅限 null/string/number/boolean）。

## 错误码

| 代码 | 含义 |
|---|---|
| `E_PARSE` | SQL / 计划文件解析失败 |
| `E_TYPE` | 类型错误（未知列/表、歧义列、聚合非数值、比较类型不匹配等） |
| `E_NON_EQUIV` | 等价性验证失败（结果哈希不一致或规则前置条件被破坏） |
| `E_UNSUPPORTED` | 不支持的语法（非等值连接、ORDER BY、DISTINCT、子查询等） |

错误以 JSON 输出到 stderr，退出码 1。

## 测试

```sh
node --test
```

覆盖验收标准：① ≤300 行随机数据上优化计划与直接枚举全量一致；② NULL/unknown
边界；③ 并列最低代价计划全部报告；④ 错误改写被拒绝。真实运行结果见
`TEST_RESULTS.md`。

## 布局

- `src/parser.js` SQL 子集解析（SELECT/FROM/JOIN ON/WHERE/GROUP BY/HAVING）
- `src/plan.js` 逻辑计划构建、模式解析、类型检查
- `src/optimizer.js` 三条改写规则（纯函数，不污染原计划）
- `src/physical.js` 物理计划枚举 + 代价模型 + 并列最优
- `src/exec.js` 直接枚举执行器（基准真值）与物理算子执行器
- `src/cert.js` 等价证书；`src/verify.js` 等价验证；`src/bench.js` 基准
- `src/cli-main.js` / `bin/cli.js` CLI
