# Parquet 页索引裁剪

`dataeng` 是一个无外部依赖、可直接嵌入查询引擎的 C++20 Parquet page index
裁剪组件。它把 Parquet `ColumnIndex`（每个 page 的 min/max/null page）、
`OffsetIndex`（`first_row_index`）和列的排序语义结合起来，返回候选 page
以及合并后的行区间。

组件遵循“宁可多读一页，不可漏掉一行”的原则：只有在统计信息能够证明某个
page 不可能包含匹配行时才裁掉它。

## 接入方式

```cmake
add_subdirectory(path/to/dataeng)
target_link_libraries(your_engine PRIVATE dataeng)
```

```cpp
#include "dataeng.hpp"

using namespace dataeng;

ColumnDescriptor column =
    ColumnDescriptor::make(PhysicalType::Int64);       // sort_order = Signed

ColumnIndex column_index;
column_index.null_pages = {false, false};
column_index.min_values = {
    Literal::Int64(0).bytes,
    Literal::Int64(100).bytes,
};
column_index.max_values = {
    Literal::Int64(99).bytes,
    Literal::Int64(199).bytes,
};
column_index.null_counts = {0, 0};

OffsetIndex offset_index;
offset_index.num_rows = 200;
offset_index.page_locations = {
    {/*offset=*/0,   /*size=*/4096, /*first_row_index=*/0},
    {/*offset=*/4096, /*size=*/4096, /*first_row_index=*/100},
};

Expr predicate =
    Expr::compare(CompareOp::GreaterEqual, Literal::Int64(150));

PageSelection selection =
    select_pages(column, column_index, offset_index, predicate);
// selection.candidate_pages == {1}
// selection.row_ranges == {{100, 200}}
```

也可以使用有状态的包装：

```cpp
PageIndexPruner pruner(column);
PageSelection selection = pruner.select(column_index, offset_index, predicate);
```

## 保守裁剪规则

- **null page**：`null_pages[i] == true` 时该页只有 null。比较谓词直接裁掉；
  `IS NULL` 保留，`IS NOT NULL` 裁掉。
- **null count**：`null_counts[i] == 0` 可以裁掉 `IS NULL`；未知的 null count
  按“可能有 null”处理。
- **列排序**：`SortOrder::Signed` / `Unsigned` 决定整数、字符串和 decimal
  的比较方式。`SortOrder::Unknown` 时完全禁用 min/max 裁剪，只保留
  null-page 判断。
- **NaN**：min/max 中出现 NaN 表示该页统计不可信，禁用该页的 min/max 裁剪；
  谓词字面量本身是 NaN 时按 IEEE 比较语义处理（只有 `!=` 为真）。
  Parquet 的 min/max 不能证明不存在 NaN，因此浮点页上的 `!=` 在调用方
  没有显式设置 `may_contain_nan=false` 时不会因为 min=max 而裁掉。
- **截断字符串统计**：
  - min 统计即使被截断，仍然是一个合法的下界。
  - max 统计被截断时，按“真实 max 以该统计为前缀”处理。对于前缀 `p`，
    组件计算最小的严格上界 `successor(p)`（例如 `"abc" -> "abd"`），
    所有真实值都 `< successor(p)`。这同时兼容“截断为前缀”和“截断后
    进位”的 writer，不会因为 `"abcz"` 这类值产生假阴性。
  - 未提供 `is_min_value_exact` / `is_max_value_exact` 时，二进制列默认
    视为可能截断。若确定 writer 不截断二进制统计，可设置
    `PruningOptions::assume_binary_stats_exact_when_unspecified = true`。
- **NULL 三值逻辑**：比较与 null 运算得到 NULL；`NOT`、`AND`、`OR` 使用
  may-true / may-false 抽象求值，保证 `NOT` 和嵌套表达式也不会误裁。

`BoundaryOrder` 会被保留在数据结构中，但逐页 min/max 本身已经是该页的
上下界，不依赖页间是否有序；组件不会为了利用页间有序而承担额外的
假阴性风险。

## 嵌套 repeated 列的行区间

`OffsetIndex.page_locations[i].first_row_index` 表示该页第一行。普通列中
相邻页的行区间是 `[first_row_index_i, first_row_index_{i+1})`。
repeated 列可能把一个 row 拆到多页，因此下一页的 `first_row_index` 可能
等于当前页。

组件按以下方式映射：

- 每个候选页至少覆盖它的起始行；
- 相邻/重叠区间合并；
- `select_pages` 返回合并后的 `row_ranges`，例如
  `first_row_index = {0, 0, 1, 1, 2}`、候选页为 `{1, 3}` 时返回
  `{{0, 2}}`。
- 如果某个候选页没有对应的 `OffsetIndex` 项且已知 `num_rows`，返回整个
  chunk 的行区间并令 `row_ranges_complete = false`，避免把“无法映射”
  误当成“没有匹配”。

## 逐页扫描对照

`verify_selection` 接受物化后的 `ScannedPage`，逐行执行同一谓词，并检查
每一个 TRUE 行是否落在候选页或候选行区间内：

```cpp
std::vector<ScannedPage> pages = load_pages_from_parquet(...);
VerificationReport report =
    verify_selection(selection, pages, column, predicate);
if (!report.ok) {
  // report.missed_rows: 被裁掉但实际匹配的行
  // report.matching_pages_not_selected: 漏掉的候选页
}
```

只关心页集合时可以直接使用
`verify_page_selection(selection.candidate_pages, pages, column, predicate)`。

候选页多于实际匹配页只会出现在
`report.selected_pages_without_match` 中，属于正常的保守多读，不影响
`report.ok`。

## 构建与测试

```bash
cmake -S . -B build
cmake --build build -j
ctest --test-dir build --output-on-failure
```

测试覆盖整数边界、null page、NaN、截断字符串、未知排序、decimal、
unsigned、AND/OR/NOT、repeated 行区间合并，并用随机数据把裁剪结果与
逐页扫描结果做对拍。
