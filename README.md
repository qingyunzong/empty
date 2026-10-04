# stable-search-pagination

TypeScript + Node.js 内置库实现的确定性搜索分页库，无第三方运行时依赖。

## 设计

- **稳定排序**：命中按 `(score 降序, id 升序)` 全序排列（`compareHits`），同分并列由 id 决定名次，结果完全确定。
- **游标绑定**：游标为 base64url 编码的 JSON，内含索引实例 id、索引版本号、查询摘要（归一化查询的 SHA-256）以及上一页末位键 `(score, id)`。
  - 索引任何增删改都会递增版本号，旧游标抛出 `StaleCursorError`；
  - 换用不同查询抛出 `CursorQueryMismatchError`；
  - 畸形或他实例游标抛出 `InvalidCursorError` / `StaleCursorError`。
- **预算诚实性**：`budget` 限制单次请求评估的文档数。预算耗尽时返回
  `complete: false`（未闭合）与 `incompleteReason: "budget_exhausted"`，
  绝不把未扫描部分当作不存在而静默跳过未知高分项；同时仍给出
  `nextCursor` 供继续。
- **独立全扫描核对**：`fullScan()` 是独立的参考实现；测试对多种页大小
  断言「各页拼接 === 全扫描结果」（顺序）且「各页 id 集合 === 全扫描 id
  集合、无重复」（并集）。

## 使用

```ts
import { SearchIndex } from "./src/index.js";

const index = new SearchIndex([{ id: "a", text: "apple pie" }]);
const page1 = index.search("apple", { limit: 10, budget: 1000 });
if (!page1.complete) {
  // 预算不足：结果未闭合，可能存在未知高分项
}
const page2 = index.search("apple", { limit: 10, cursor: page1.nextCursor! });
```

## 测试

```
npm test    # tsc 编译 + node --test
```

## 实际测试结果（2026-10-05，Node v22.22.1，typescript 7.0.2）

`npm test` 退出码 0，15 个测试全部通过：

```
ok 1 - stable ordering
    ok 1 - ties on score are broken by id ascending, total order is deterministic
ok 2 - cursor pagination vs independent full scan
    ok 1 - page size 1: union equals full scan, order preserved, no duplicates
    ok 2 - page size 3: union equals full scan, order preserved, no duplicates
    ok 3 - page size 7: union equals full scan, order preserved, no duplicates
    ok 4 - page size 64: union equals full scan, order preserved, no duplicates
    ok 5 - page size 1000: union equals full scan, order preserved, no duplicates
    ok 6 - query with no matches yields one empty, complete page and no cursor
ok 3 - cursor binding
    ok 1 - cursor is rejected after the index changes (stale version)
    ok 2 - update and remove also invalidate cursors
    ok 3 - cursor is bound to the query digest
    ok 4 - malformed and foreign cursors are rejected
ok 4 - budget accounting
    ok 1 - insufficient budget returns an incomplete (not closed) page
    ok 2 - budget covering the whole index closes the page
    ok 3 - incomplete pages never silently drop unknown high-score items
    ok 4 - resuming with a cursor continues to spend budget honestly

# tests 15
# suites 4
# pass 15
# fail 0
```
