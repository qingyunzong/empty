# meta-evidence-rank

荟萃分析证据排名的增量维护库与 CLI。Node.js 22，仅标准库，`node:test` 测试，全程离线。

## 模型

- **研究节点 (study)**：`{ id, weight, effect, active }`。`weight >= 0` 且有限，`effect` 为有限数，`active=false` 表示已撤回。
- **声明/假设节点 (claim)**：`{ id, op: 'all' | 'any', refs: [...] }`，引用研究或其他声明。
  - `all`：全部引用可用时假设有效，纳入研究集为所有引用可用研究的并集。
  - `any`：至少一个引用可用即有效，纳入研究集为可用引用的研究并集。
  - 引用可用性：研究须 `active`；声明须自身评估为 `ok`；缺失引用视为不可用。
- **总分**：纳入研究的加权平均 `sum(w_i * e_i) / sum(w_i)`。
- **排名**：总分降序；并列按假设 id 升序（字符串序）；名次为 1 起的稠密序号。

## 约定结果

| 场景 | 约定 |
| --- | --- |
| 零权重研究 | 仍计入纳入集合，但对分子分母贡献为 0 |
| 纳入集合权重和为 0 | 假设 `excluded`，原因 `zero_total_weight`，不参与排名 |
| 无有效研究 / 空引用 | 假设 `excluded`，原因 `no_valid_studies` |
| 引用环（含自环） | 环上假设状态 `error`，错误码 `E_CYCLE`，不参与排名；环外引用者将该引用视为不可用；破坏环后增量恢复 |
| 全部研究撤回 | 排名为空，全部假设 `excluded` |
| 同序号冲突 | 相同 `(seq, authorId)` 的两条操作 → `E_SEQ_CONFLICT`，整批不应用（原子） |
| 同 seq 不同 author | 按 `authorId` 字符串升序决定先后，确定性重放 |

## 增量维护

每次变更（撤回/恢复/权重或效应量更正/加减边/增删节点）：

1. 沿反向依赖图做可达性分析，得到受影响假设集 `affected`；
2. 仅失效并重算这些假设（其余命中缓存）；
3. 重建排名并产出最小差分 `rankingDiff: [{ id, from, to }]`（`null` 表示不在排名中）。

## 证书

`getCertificate(id)` 返回 `{ hypothesisId, status, studies, score, rank, hash }`（ excluded 时附 `reason`，error 时附 `error`）。`hash` 为证书内容（不含 hash 字段）经键序规范化 JSON 后的 SHA-256。

## 操作类型

`add_study` `remove_study` `retract_study` `restore_study` `set_weight` `set_effect` `add_claim` `remove_claim` `add_edge` `remove_edge`。每条历史操作须含数值 `seq` 与字符串 `authorId`，重放按 `(seq, authorId)` 排序。

## CLI

```sh
node cli.js [--certificate <claimId>] [--diffs] [ops.json]   # 无文件参数时读 stdin
```

输出 JSON：`{ ok, applied, errors, ranking, excluded, [diffs], [certificate] }`。失败（解析错误、序号冲突、操作错误、证书目标缺失）时退出码为 1。

## API 摘要

```js
import { EvidenceGraph, ERR } from './src/evidence.js';
const g = new EvidenceGraph();
g.addStudy('s1', { weight: 2, effect: 0.4 });
g.addClaim('h1', { op: 'any', refs: ['s1'] });
g.retractStudy('s1');            // => { affected, rankingDiff }
g.replay(ops);                   // => { ok, applied, errors, diffs }
g.getRanking();                  // => [{ id, score, rank }]
g.getExcluded();                 // => [{ id, status, reason }]
g.getCertificate('h1');          // => { ..., hash }
```

## 测试

```sh
node --test > test-results.txt 2>&1
```

- `test/incremental.test.js`：≤6 假设、≤10 研究的随机场景下，增量结果与全量重算及参考排序逐操作对比（60 种子 × 25 变更）。
- `test/retraction.test.js`：撤回关键研究后的最小排名差分、并列按 id 升序的稳定性。
- `test/edge-cases.test.js`：零权重、环、全部撤回、同序号冲突等约定结果。
- `test/cli.test.js`：CLI 的 JSON 输出、证书、差分与错误退出码。
