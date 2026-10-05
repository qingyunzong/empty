# stable-search-pagination

TypeScript 搜索分页库，仅依赖 Node.js 内置模块（`node:crypto`、`node:test`、`node:assert`），无第三方运行时依赖。

## 设计

- **稳定排序**：结果按 `(score 降序, id 升序)` 全序排列（`compareHits`，见 `src/search.ts`），同分按 id 字典序决胜，顺序确定且可复现。
- **游标绑定**：游标为 base64url 编码的不透明负载，内含
  - `v`：索引版本号（`SearchIndex` 每次增删文档自增）；
  - `q`：查询摘要（规范化 JSON 的 SHA-256 截断）；
  - `ks`：keyset 位置（上一页末项的 `(score, id)`）；
  - `so` / `m` / `buf`：预算中断时的扫描进度（扫描偏移、已匹配计数、缓冲的 top-`limit` 候选）；
  - 外层附 SHA-256 校验和，篡改或损坏的游标抛 `MalformedCursorError`。
  索引版本不一致抛 `StaleCursorError`（索引变化后旧游标被拒绝）；查询摘要不一致抛 `QueryMismatchError`。
- **预算与未闭合**：`budget` 限制单次调用扫描的文档数。预算耗尽而扫描未完时，未扫描尾部可能藏有未知高分项，因此返回 `closed: false`、`items: []`——不提前释放任何结果，也就不会跳过未知高分项；游标仅记录扫描进度，调用方持游标续扫直至 `closed: true` 才获得该页结果。
- **独立全扫描核对**：`fullScan` 独立遍历索引、打分、排序；测试用它核对各页并集等于全集、无重复、且拼接顺序与全扫描完全一致。

## 使用

```ts
import { SearchIndex, search } from "./src/search.ts";

const index = new SearchIndex();
index.add({ id: "d01", text: "x x x" });

let cursor: string | undefined;
do {
  const page = search(index, { term: "x" }, { limit: 10, budget: 1000, cursor });
  if (!page.closed) {
    cursor = page.nextCursor!; // 预算不足：继续扫描，本页尚未释放任何结果
    continue;
  }
  console.log(page.items);
  cursor = page.nextCursor ?? undefined;
} while (cursor !== undefined);
```

## 测试

```sh
npm test        # tsc 编译后运行 node:test 用例
npm run typecheck
```

## 实际测试结果

以下为本仓库 `npm test` 的真实输出（Node v22.22.1，tsc 7.0.2，11 个用例全部通过）：

```
> stable-search-pagination@1.0.0 test
> tsc -p tsconfig.json && node dist/test/search.test.js

TAP version 13
# Subtest: results are stably sorted by score desc then id asc
ok 1 - results are stably sorted by score desc then id asc
# Subtest: paginated union and order match an independent full scan
ok 2 - paginated union and order match an independent full scan
# Subtest: non-matching docs are excluded from pages and full scan
ok 3 - non-matching docs are excluded from pages and full scan
# Subtest: cursor is rejected after the index changes
ok 4 - cursor is rejected after the index changes
# Subtest: cursor is rejected for a different query
ok 5 - cursor is rejected for a different query
# Subtest: malformed or tampered cursors are rejected
ok 6 - malformed or tampered cursors are rejected
# Subtest: query digest is canonical with respect to key order
ok 7 - query digest is canonical with respect to key order
# Subtest: insufficient budget returns unclosed and skips nothing
ok 8 - insufficient budget returns unclosed and skips nothing
# Subtest: tight budget across every page still matches the full scan
ok 9 - tight budget across every page still matches the full scan
# Subtest: zero budget makes no progress but stays resumable
ok 10 - zero budget makes no progress but stays resumable
# Subtest: budget is rejected when negative and limit must be positive
ok 11 - budget is rejected when negative and limit must be positive
1..11
# tests 11
# suites 0
# pass 11
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 113.943861
```
