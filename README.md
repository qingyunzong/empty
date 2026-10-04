# log-segment-search

日志搜索库：在按 `(time, id)` 排序的事件流中，找出满足多重关键词需求的
**最短连续事件段**，并输出可独立核对的证书。仅使用 TypeScript 与
Node.js 内置库（`node:test` / `node:assert`），无任何第三方依赖。

## 需求模型

- **事件** `LogEvent`：`{ id, time, source, keywords[] }`，流内按
  `(time, id)` 升序维护（二分插入，无需整体重排）。
- **需求** `Requirement`（最多 12 个，超出抛错）：
  - `keyword`：匹配事件必须包含该关键词；
  - `prereqs?: number[]`：前置依赖——本需求匹配的事件在事件序上必须
    严格晚于每个前置需求匹配的事件（依赖必须构成 DAG，成环抛错）；
  - `mutexGroup?: string`：来源互斥——同组需求必须匹配到来源互不相同
    的事件。
- **一对一约束**：同一事件最多满足一个需求位（匹配是单射）。
- **最短段**：以段内事件数衡量；并列时取开始下标最早者。

## 算法

- 快速路径 `findShortestSegment`：双指针扫描。固定左端点时可行性关于
  右端点单调，且最小可行右端点随左端点单调不减，故每次重算为 O(n) 次
  匹配探测；匹配本身用回溯（按拓扑序分配需求、鸽笼剪枝、互斥组来源
  集合剪枝）。
- 变更（`addEvent` / `correctEvent` 迟到更正 / `deleteEvent`）使缓存
  失效并触发增量重算；`result()` 仅在脏时重算。

## 证书与独立核对

- **需求计数证书** `certificate()` / `enumerateCertificate`：枚举全部
  O(n²) 区间，给出需求总数、满足数、最短长度、最短长度下的可行区间数
  及最早开始下标。
- **一对一匹配证书**：`SearchResult.matching` 给出 需求下标 → 事件 id
  的对应；`validateMatchingCertificate` 独立重验单射性、关键词包含、
  前置顺序与来源互斥。
- **独立核对** `verify()`：使用与快速路径完全不同的匹配实现
  （自然序分配 + 叶节点全约束重查）重新枚举所有区间，交叉确认最短
  长度、并列最早开始与匹配证书合法性；伪造结果会被判失败。

## 使用

```ts
import { LogSegmentSearcher } from "log-segment-search";

const s = new LogSegmentSearcher([
  { keyword: "boot" },
  { keyword: "ready", prereqs: [0] },
  { keyword: "x", mutexGroup: "g" },
  { keyword: "y", mutexGroup: "g" },
]);
s.addEvent({ id: "a", time: 1, source: "s1", keywords: ["boot", "x"] });
// ...
const r = s.result();        // 最短段 + 一对一匹配证书
const cert = s.certificate(); // 需求计数证书（全区间枚举）
const report = s.verify();    // 独立核对，report.ok === true
s.deleteEvent("a");           // 删除后自动重算
s.correctEvent({ id: "b", time: 5, source: "s2", keywords: ["ready"] }); // 迟到更正
```

## 测试

```sh
npm test   # tsc 编译后运行 node --test
```

### 实际测试结果（2026-10-05，Node v22.22.1，tsc 7.0.2）

```
ok 1 - finds the shortest segment covering all keyword requirements
ok 2 - events are ordered by (time, id) regardless of insertion order
ok 3 - ties in length are broken by the earliest start
ok 4 - one event cannot satisfy two requirement slots
ok 5 - prerequisite dependencies enforce event order
ok 6 - source mutex forces distinct sources within a group
ok 7 - deletion triggers recomputation
ok 8 - deleting every feasible event yields null and a verified infeasible certificate
ok 9 - late corrections re-sort and recompute incrementally
ok 10 - correctEvent inserts unknown ids (upsert)
ok 11 - requirement count is capped at 12
ok 12 - cyclic prerequisites are rejected
ok 13 - tampered matching certificates are rejected
ok 14 - randomized streams always pass independent enumeration verification
ok 15 - verifyResult detects a forged result
# tests 15
# pass 15
# fail 0
# duration_ms ~220
```

其中测试 14 为确定性随机回归：30 轮 × 40 步随机插入/迟到更正/删除，
每一步都用独立枚举核对快速路径结果与计数证书。

## 目录结构

- `src/model.ts` — 公共类型（事件、需求、结果、证书、核对报告）
- `src/matching.ts` — 拓扑排序、回溯匹配、匹配合法性校验
- `src/search.ts` — 双指针最短段搜索
- `src/verify.ts` — 独立枚举核对器与证书校验
- `src/searcher.ts` — 增量维护事件流的 `LogSegmentSearcher`
- `test/searcher.test.ts` — 15 个 `node:test` 测试
