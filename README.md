# genealogy-vcs

质量追溯谱系版本库与 CLI。谱系为有向无环图（DAG）：`lots` 为批次节点，
`edges` 为 `{child, parent, relation}`，方向由 child 指向 parent。
仅使用 Node.js 22 标准库与 `node:test`，无第三方依赖。

## 数据格式

```json
{
  "lots": ["A", "B"],
  "edges": [{ "child": "A", "parent": "B", "relation": "consumes" }]
}
```

输入图必须是合法 DAG：引用存在的批次、无自环、无重复边、无有向环。

## 三方合并规则

以 base / local / remote 三个版本做基于边集合（含 `relation` 属性）的三方合并，
对每条边 `(child, parent)`：

- 仅一方变更 → 采纳该方；
- 双方增删同一边且动作相同 → 采纳；
- 一方加边另一方删边、一方删边另一方改 relation、或同一 relation 被改成两个不同值 → 冲突；
- 合并结果若引用不存在的节点、出现自环或形成有向环 → 冲突。

节点（批次）按同样的三方集合规则合并，本身不产生冲突。

## CLI

```sh
node index.js merge-genealogy --base base.json --local local.json --remote remote.json --out result.json
```

输出文件包含 `merged`（合并后图）、`conflicts`（冲突列表）、`baseHash`
（base 图的 SHA-256 三方基哈希，按规范化排序后的 JSON 计算）。

退出码：

- `0` 合并成功无冲突；
- `1` 存在冲突（结果文件仍会写出）；
- `2` 输入 JSON 或引用格式错误。

## 库 API

```js
const { normalizeGraph, mergeGraphs, isDag, reachable, hashGraph } = require('./lib/genealogy');
```

## 测试

```sh
node --test
```

`test/exhaustive.test.js` 以不超过 4 个批次枚举所有可能边子集，用测试内独立
实现的 DFS 对照判定 DAG 与可达性；并对 n≤3 的全部无环图三元组及 n=4 的随机
采样三元组穷举验证三方合并决策与环检测。
