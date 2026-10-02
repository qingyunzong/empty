# lineage-merge

单机离线环境下的分布式实验谱系（experimental lineage）并发判定与合并库及 CLI。
仅使用 Node.js 22 标准库，测试基于 `node:test`。

## 数据模型

每个版本（version）包含：

- `author`：作者
- `clock`：向量时钟（`{nodeId: counter}`）
- `parents`：父版本谱系哈希数组
- `results`：结构化结果表（字段 → 数值/字符串等）
- `evidence`：证据引用数组（每项含唯一 `id` 与可选 `label`）
- `hash`：谱系哈希，对上述负载的规范 JSON 取 SHA-256

## 库

- `lib/vclock.js` — happens-before / 并发判定（`compare` → LESS/EQUAL/GREATER/CONCURRENT）、
  逐分量取最大合并（`mergeClocks`）、时钟倒退检测（`isRegression`）
- `lib/version.js` — 谱系哈希计算与版本校验（未知父引用、时钟倒退、重复证据 ID）
- `lib/store.js` — 目录型版本存储（每版本一个 `<hash>.json`）
- `lib/merge.js` — 合并算法：
  - 祖先版本直接快进（fast-forward），不产生新提交
  - 并发版本仅在字段不冲突且证据标签不互斥时合并：结果表取字段联合，
    证据按 `id` 取并集，合并时钟逐分量取最大，重新计算谱系哈希
  - 矛盾数值（`numeric-contradiction`）或互斥证据标签（`exclusive-evidence`）
    生成冲突证书，不创建合并提交

## CLI

```
node cli.js add <version.json> [--store DIR]     # 校验、哈希、入库，打印谱系哈希
node cli.js merge <hashA> <hashB> [--store DIR] [--conflicts FILE]
node cli.js compare <hashA> <hashB>              # happens-before|happens-after|equal|concurrent
node cli.js show <hash> / list
```

退出码：

- `0` 成功（快进或合并）
- `1` 错误：未知父引用、时钟倒退、重复证据 ID、用法错误
- `2` 合并矛盾：写出 `pairwise-conflicts.json`（默认当前目录，可用 `--conflicts` 指定），
  不生成合并提交

互斥标签组默认 `[["positive","negative"],["accepted","rejected"],["control","treatment"]]`，
可用 `--exclusive-groups '<json>'` 覆盖。

## 测试

```
node --test
```

覆盖：快进、并发兼容合并、矛盾标签冲突、错误退出码；并对三维以内小向量枚举
所有时钟对，用独立实现的偏序定义验证 `compare` 及偏序公理（自反、反对称、传递）。
