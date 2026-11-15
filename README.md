# Parquet 页索引三态裁剪

`dataeng` 是一个可嵌入的 C++20 Parquet page-index 裁剪组件。它只使用已解码的
column index（min/max、null page、null count、boundary order）和 offset
index（页起始 row、可选的首个 repetition level），不读取或解压页数据。

核心保证：**只会排除能够证明不可能匹配的行/页；结果不产生假阴性。**

## 构建与测试

```bash
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j
ctest --test-dir build --output-on-failure
```

测试包含固定用例和随机属性测试。属性测试逐行按 SQL 三值语义求值，再验证裁剪
结果没有漏掉任何应返回的行；嵌套 repeated 列也有独立的随机测试。

## 快速使用

```cpp
#include "dataeng.hpp"

using namespace dataeng;

RowGroupIndex group;
group.num_rows = 100;

ColumnPageIndex age;
age.pages = {
    PageStatistics{.min_value = Value::int64(0),
                   .max_value = Value::int64(24),
                   .null_count = 0},
    PageStatistics{.min_value = Value::int64(25),
                   .max_value = Value::int64(49),
                   .null_count = 0},
    PageStatistics{.min_value = Value::int64(50),
                   .max_value = Value::int64(74),
                   .null_count = 0},
    PageStatistics{.min_value = Value::int64(75),
                   .max_value = Value::int64(99),
                   .null_count = 0},
};
age.page_locations = {PageLocation{.first_row_index = 0},
                      PageLocation{.first_row_index = 25},
                      PageLocation{.first_row_index = 50},
                      PageLocation{.first_row_index = 75}};
group.columns.emplace("age", std::move(age));

const PruneResult result =
    prune(group, Predicate::all({Predicate::ge("age", Value::int64(60)),
                                 Predicate::lt("age", Value::int64(90))}));

for (const RowRange& range : result.candidate_rows) {
  // [range.begin, range.end) 需要扫描；候选区间是保守超集。
}
if (const PageSelection* pages = result.pageSelection("age")) {
  for (std::int32_t page : pages->pages) {
    // 只需要读取这些页。
  }
}
```

`ColumnPageIndex::from(column_index, offset_index, max_rep, max_def)` 可以直接
把 Parquet 的 `ColumnIndex` / `OffsetIndex` 解码结果拼成上述视图。repeated
列必须传入正确的 `max_repetition_level`；否则组件会按 flat 列处理。

## 语义与规则

- **三值谓词**：页/行段结果为 `TRUE`、`FALSE` 或 `UNKNOWN`。缺失 min/max、
  缺失 offset index、类型不可比较、null count 不足等都不会被当成 `FALSE`。
  SQL `WHERE` 语义下 null 比较不选中；`IsNull` / `IsNotNull` 是显式叶子。
- **AND / OR**：在行段上按三值集合组合。AND 取候选交集，OR 取并集；
  `FALSE AND UNKNOWN = FALSE`，`FALSE OR UNKNOWN = UNKNOWN`。多列页边界
  不同时会按所有页边界切分行段，再组合。
- **截断边界**：`min_value` 始终按下界使用，`max_value` 始终按上界使用。
  截断/widen 后仍可做范围裁剪；但 `x == c` / `x != c` 的“全部等于 c”推导
  要求 `min_exact && max_exact`。从 Parquet 读取的 binary 边界如果可能被
  截断，应把对应 `PageStatistics::min_exact/max_exact` 置为 `false`；
  `ColumnPageIndex::from` 对 binary 边界默认按“可能截断”处理。
- **null page**：比较谓词不会选中全 null 页；`IsNull` 保留全 null 页，
  `IsNotNull` 排除全 null 页。flat 列可用 `null_count == 页行数` 辅助判断；
  repeated 列不把 null count 与行数直接比较。对 repeated 列，
  `IsNull` / `IsNotNull` 指是否存在 null / non-null 的 leaf value；比较谓词
  按“任一非 null leaf value 满足”处理。
- **boundary order**：校验 `Ascending` / `Descending` 是否与各页 min/max
  序列一致。越界枚举、顺序矛盾、`min > max`、页数不一致、row index 倒退
  等结构损坏会让 `PruneResult::status == PruneStatus::CorruptIndex`，
  `fallback == true`，并返回整个 row group 的全部行和页。
- **嵌套 repetition level**：offset index 的 `first_row_index` 给出页起始
  record；若后一页的 `first_repetition_level > 0`，前一页和后一页共享该
  record，候选页会同时包含两页。repetition level 未知时按“可能跨界”处理。
  repeated 列的页级 `TRUE` 不会直接当成行级 `TRUE`，因为某行可能有空 list；
  但页级 `FALSE`（页内所有值都不满足）可以用于裁剪。

## 结果

`PruneResult` 包含：

- `candidate_rows`：排序、合并后的候选行区间，是所有可能匹配行的保守超集；
- `page_selections`：每个列逐页的候选标记、候选页索引和 `all` 标志。这里标记
  的是“包含任一候选行、需要读取”的页；对谓词列而言它是可能满足谓词的页的
  保守超集（OR/投影场景会保留额外页）；
- `fallback` / `status` / `detail`：损坏索引的整 row-group 回退信息；
- `has_unknown`：是否有候选行因 min/max、null count、offset index 等元数据
  缺失、类型不可比或无法映射而保留。范围重叠导致的普通“候选”不置位该标志。

组件不判断“某行一定匹配”，只判断“是否可能匹配”。因此行过滤仍应在读取候选
页后执行；页裁剪只负责减少 I/O。
