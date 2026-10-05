# log-segment-search

在按 `(time, id)` 排序的日志事件流中，查找满足多重关键词需求的**最短连续事件段**，
并输出可独立核对的证书。仅使用 TypeScript + Node.js 内置库（`node:test` / `node:assert`），
无第三方运行时依赖。

## 语义

- 事件 `LogEvent { time, id, source, keywords }`，索引内始终按 `(time, id)` 升序。
- 需求 `Requirement { keyword, dependsOn?, mutexGroup? }`，最多 12 个需求位
  （`MAX_REQUIREMENTS = 12`，超出即抛错，依赖成环也抛错）：
  - `keyword`：匹配事件必须包含该关键词；
  - `dependsOn`：被依赖需求匹配到的事件必须严格排在前面（前置依赖）；
  - `mutexGroup`：同组需求必须匹配到来源互不相同的事件（来源互斥）。
- 同一事件只能满足一个需求位（一对一匹配）。
- 最短段 = 包含事件数最少的连续下标区间；并列时取开始下标最早者。

## API

- `findShortestSegment(events, reqs)`：双指针扫描（可行性关于右端点单调），
  返回 `SearchCertificate { lo, hi, length, requirementCount, matching }` 或 `null`。
- `LogSearchIndex`：增量索引。`addEvent`（支持迟到乱序更正，二分插入）、
  `removeEvent(id)` 使缓存失效，`search(reqs)` 惰性重算。
- `verifyCertificate(events, reqs, cert)` / `index.verify(reqs, cert)`：独立核对——
  用朴素枚举匹配器遍历**所有区间**验证最短性与并列规则，
  并逐项检查一对一匹配证书的合法性（关键词、依赖顺序、来源互斥、事件不复用）。

求解器使用拓扑序回溯匹配（带剪枝）；验证器使用无剪枝的全枚举匹配器，
两条独立代码路径互相交叉核对。

## 运行测试

```sh
npm test   # tsc 编译后运行 node --test
```

## 实际测试结果（2026-10-05，Node v22.22.1，tsc 7.0.2）

```
ok 1 - finds the shortest contiguous segment for multiple keyword requirements
ok 2 - events are ordered by (time, id) and ties break to the earlier start
ok 3 - one event can satisfy only one requirement slot
ok 4 - prerequisite dependencies enforce event order
ok 5 - source mutual exclusion requires distinct sources within a group
ok 6 - enforces the 12-requirement limit and rejects dependency cycles
ok 7 - deletion triggers recomputation of the shortest segment
ok 8 - late out-of-order corrections are integrated incrementally
ok 9 - returns null when requirements are infeasible and verification agrees
ok 10 - verification rejects tampered certificates
ok 11 - randomized cross-check: solver vs independent interval enumeration
# tests 11
# pass 11
# fail 0
```

用例 11 为确定性随机化测试（种子 20261005，300 轮）：每轮随机乱序插入事件、
随机删除、随机生成 1–4 个带依赖/互斥的需求，比较求解结果与独立全区间枚举，
全部一致。
