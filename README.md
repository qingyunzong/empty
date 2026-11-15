# 数据库快照分块键范围

`dataeng` 是可直接接入全量抽取器的主键范围规划库。它把一张表的主键空间划分为
半开区间 `[lower, upper)`，所有边界都来自同一个快照中的真实主键元组。

## 保证

- **复合主键**：按主键索引列顺序进行字典序比较，每列可独立设置升降序。
- **显式 null 排序**：支持 `NULLS FIRST`/`NULLS LAST`，且不受升降序影响。
- **字符串 collation**：规划器用与数据库一致的 `Collation` 比较器排序和去重边界；
  生成 SQL 时同时输出 `COLLATE` 与 null 排序。
- **同一快照**：`Planner` 只调用一次 `BeginSnapshot`，边界采样、行数统计和后续分块读取
  共用返回的快照/事务。
- **无遗漏、无重叠**：边界严格递增；前一块的上界是下一块的下界，左闭右开语义由
  `ValidateChunks` 和查询条件共同校验。
- **无主键表不可用**：返回带表名的 `NoPrimaryKeyError`（`errors.Is(err, ErrNoPrimaryKey)`）。
  库中不存在 `LIMIT/OFFSET` 分页降级路径。

## 规划

`KeySource` 是规划器所需的最小快照接口：

```go
cols := []dataeng.KeyColumn{
    {Name: "tenant_id", Kind: dataeng.KindInt},
    {Name: "user_id", Kind: dataeng.KindString, Collation: dataeng.NamedCollation{
        SQLName: "NOCASE",
        // 必须与数据库 collation 的顺序一致。
        Cmp: func(a, b string) int {
            return strings.Compare(strings.ToLower(a), strings.ToLower(b))
        },
    }},
}

planner := dataeng.Planner{
    Source:  snapshotSource, // 实现 dataeng.Source
    Options: dataeng.Options{ChunkCount: 8},
}

plan, err := planner.Plan(ctx, "public.users")
if err != nil {
    if errors.Is(err, dataeng.ErrNoPrimaryKey) {
        return err // 明确拒绝，不使用 offset 分页
    }
    return err
}
defer plan.Close() // 关闭计划持有的快照
```

`BuildPlan` 也可直接接收调用方自有的 `KeySource`；此时快照生命周期由调用方管理。

## 查询

每个 `Chunk` 生成半开区间条件。复合键会展开成字典序比较，并显式处理 NULL 和
collation；不会使用 SQL 行构造器所不支持的 null 排序，也不会生成 OFFSET：

```go
queries, err := plan.Queries(dataeng.Postgres, []string{"tenant_id", "user_id", "payload"})
for _, q := range queries {
    rows, err := plan.Snapshot.(*dataeng.SQLSnapshot).Tx().QueryContext(ctx, q.SQL, q.Args...)
    // 读取完整分块，并在同一快照上 continue
    _ = rows
    _ = err
}
```

SQL 条件语义与 `Chunk.Contains` 一致：下界包含、上界不包含。查询按主键列排序，
不附带 `LIMIT`/`OFFSET`。

## PostgreSQL 快照

```go
src := &dataeng.SQLSource{
    DB:      db,
    Dialect: dataeng.Postgres,
    Catalog: dataeng.PostgresCatalog{
        ResolveCollation: func(name string) (dataeng.Collation, error) {
            // 返回与数据库 collation 相同顺序的 Go 比较器。
        },
    },
}
```

默认事务选项为 `REPEATABLE READ` + `READ ONLY`。边界采样使用同一事务内的
`ROW_NUMBER()` 采样；也可以为任意数据库提供自定义 `Catalog`、`Dialect` 或
`KeySource`。
