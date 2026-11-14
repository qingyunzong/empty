# YAML 1.2 表示图

面向配置采集服务的 YAML 1.2 表示图构建库。它保留 anchor/alias 的共享节点身份，解析 merge key，记录字段来源，并对别名展开成本设置预算。

## 使用

```ts
import { parseYamlGraph, toJS, traceField } from "./index.ts";

const root = parseYamlGraph(`
base: &base
  host: localhost
  port: 5432
service:
  <<: *base
  port: 6432
`);

const service = root.get("service")!;
const base = root.get("base")!;

service.get("host") === base.get("host"); // true：共享节点，不是深复制
const provenance = service.getEntry("port")!.provenance;
provenance[0].kind;                         // "explicit"
provenance[1].kind;                         // "merge"
provenance[1].merge!.aliasAnchor;           // "base"
```

主要入口：

- `parseYamlGraph(source, options?)`：返回文档根节点，并在根节点上以不可枚举属性提供 `root`、`documents`、`anchors`、`aliases`、`cycles`、`stats` 等元数据。
- `parseYamlDocuments(source, options?)`：返回所有文档。
- `createYamlGraph(source, options?)`：返回带 `toJS()` / `getNode()` 的 `YamlGraph` 包装对象。
- `toJS(node, options?)`、`walkYaml()`、`getNodeAtPath()`、`getEntryAtPath()`、`traceField()`。
- `buildYamlGraph`、`buildYamlRepresentationGraph`、`parseYaml`、`parse` 等兼容别名。

## 节点模型

节点分为 `scalar`、`sequence`、`mapping` 三种。每个节点都有稳定的 `id`、`tag`、`anchor`、`path` 和 `range`。`mapping.entries` 中的条目包含解析后的 `value`、`explicit`、`sourceKind`、`origin` 和完整 `provenance`。

标量执行 YAML 1.2 core schema 的基本类型解析（null、bool、int、float、string、binary）。`raw` 保留原始标量文本，`value` 为解析后的值。引号和 block scalar 不会被误判为数字。

## Alias 与循环

alias 直接返回 anchor 指向的同一个节点对象，因此重复 alias 不会复制子树。字符串化结果也会保持共享引用：

```ts
const graph = parseYamlGraph(`
base: &base {a: 1}
one: *base
two: *base
`);
graph.get("one") === graph.get("two"); // true
```

默认遇到循环 alias 抛出 `YamlGraphError`，`code` 为 `ALIAS_CYCLE`，`path` 是反向引用的位置，错误消息包含 `... -> ...` 的循环路径。设置 `onAliasCycle: "allow"` 或 `allowCycles: true` 可保留循环共享图，循环记录位于 `graph.cycles`。

## Merge 语义

`<<` 接受映射、alias 指向的映射，或映射序列。优先级固定为：

1. 当前映射的显式键永远覆盖 merge 字段，与 `<<` 出现位置无关。
2. merge 序列中靠前的操作数覆盖靠后的操作数。
3. 同一映射中的多个 `<<` 键会依次处理，先出现的 merge 来源优先；序列形式更便于保留明确的来源路径。

结果条目顺序为：显式键按首次出现顺序排列，随后是按 merge 遍历顺序首次出现的 merge-only 键。显式键重复时由 `duplicateKeys` 决定保留 `first` 还是 `last`。

每个条目的 `provenance[0]` 是最终生效来源，后续项是 `overridden: true` 的历史来源。merge 来源包含 `merge.path`、`merge.operandPath`、`merge.aliasAnchor`、`merge.sourceAnchor` 和 `mergedFrom`，可沿来源链回到原始字段。

## 重复键策略

```ts
parseYamlGraph("a: 1\na: 2", { duplicateKeys: "last" });
```

支持 `error` / `reject`（默认）、`first` / `first-wins`、`last` / `last-wins`，也接受 `duplicateKeyStrategy`、`duplicateKeyPolicy`、`onDuplicateKey` 别名。重复键错误包含重复位置和首次定义位置。

## 安全预算

默认限制：

| 选项 | 默认值 | 含义 |
| --- | ---: | --- |
| `maxAliasExpansions` | 10000 | 所有 alias 的累计理论展开节点成本 |
| `maxAliasCount` | 100000 | alias 出现次数 |
| `maxAliasDepth` | 100 | alias 目标展开的最大嵌套深度 |
| `maxNodes` | 100000 | 解析节点总数 |
| `maxDepth` | 200 | 文档结构深度 |
| `maxMergeDepth` | 100 | merge 来源链深度 |

别名成本按目标节点可达的节点与条目边计算，深层 alias 会呈指数增长；计算过程有缓存和截断，并沿循环引用安全终止。超限时抛出 `ALIAS_BUDGET`、`ALIAS_COUNT`、`ALIAS_DEPTH` 等错误，并带 `path`/`limit`/`actual`。

## 测试

```bash
npm run typecheck
npm test
```
