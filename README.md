# lineage-merge

分布式实验谱系的并发判定与三方合并库及 CLI（Node.js 22，仅标准库）。

## 数据模型

每个版本为 JSON 对象：`author`、`clock`（向量时钟）、`parents`（父哈希数组）、
`fields`（结构化结果表）、`evidence`（证据引用，含 `id`/`label`/可选 `group`）、`hash`（谱系哈希，
对除 `hash` 外的规范 JSON 取 SHA-256）。

## 库（src/lineage.js）

- `compareClocks(a, b)` → `-1` happens-before / `0` 相等 / `1` 之后 / `null` 并发
- `validateVersion(v, store)` → 未知父引用、时钟倒退、重复证据 ID 抛 `LineageError`
- `mergeVersions(a, b, store)` → `fast-forward`（祖先直接快进）/ `merged`（并发且兼容：
  字段并集、证据并集、时钟逐分量取最大、重算哈希）/ `conflict`（矛盾数值或互斥证据标签，
  返回冲突证书）

## CLI（bin/lineage-merge.js）

```
node bin/lineage-merge.js add <storeDir> <versionFile>     # 校验并入库
node bin/lineage-merge.js merge <storeDir> <hashA> <hashB> [--out <dir>]
node bin/lineage-merge.js compare <storeDir> <hashA> <hashB>
```

退出码：`0` 成功（快进或生成合并提交）；`2` 冲突（写出 `pairwise-conflicts.json`，
不生成合并提交）；`1` 错误（未知父引用、时钟倒退、重复证据 ID 等）。

## 测试

```
node --test
```
