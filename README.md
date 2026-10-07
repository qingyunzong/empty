# async-search-merger

前端搜索库：合并多个异步到达的结果页，输出统一的有序、带版本的结果集。

## 语义

- **排序**：分数降序，分数相同按 ID 升序。
- **版本替换**：同一 ID 出现在多个页面时，以 `version` 较大者为准。
- **墓碑**：`withdrawn: true` 的版本会遮蔽该 ID 的所有旧版本，形成墓碑，
  从可见结果中排除，但保留在版本表中（`tombstones()` / `versionTable()`）。
- **查询取消**：`beginQuery()` 返回代际 token；`cancel()` 或开启新查询会使
  旧 token 失效，迟到的旧页面以 `stale-query` 拒绝，绝不进入新查询。
- **去重**：同一查询内相同 `pageIndex` 的页面只合并一次。

## 用法

```ts
import { SearchMerger } from "./src/search.js";

const merger = new SearchMerger();
const queryId = merger.beginQuery();

// 页面以任意顺序异步到达
merger.acceptPage({ queryId, pageIndex: 0, hits: [{ id: "a", score: 9, version: 1 }] });

merger.results();       // 可见结果，按分数降序、ID 升序
merger.tombstones();    // 撤回版本形成的墓碑
merger.versionTable();  // 完整版本表（含墓碑），按 ID 升序
```

## 测试

```sh
npm test
```

测试用可控的 `Deferred` promise 枚举页面的全部到达顺序（4 页共 24 种排列），
验证任意交错下合并结果都与期望版本表一致；另覆盖取消后旧页拒绝、
版本替换、墓碑遮蔽与重复页去重。
