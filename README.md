# 分区哈希连接倾斜回退

查询执行器要可嵌入 C++ grace hash join 算子，按预算递归分区并检测重键倾斜。倾斜分区切换为排序归并或单键流式策略，outer/semi/anti 语义保持一致；null 键按 SQL 三值规则处理。小表逐对嵌套循环作为结果多重集参照。

## 实现概览

头文件 `dataeng.hpp` 暴露可嵌入的模板算子，实现位于 `dataeng_impl.hpp`，
`dataeng.cpp` 提供基于 `Row`（可空 `int64` 键）的便捷重载。

- `graceHashJoin(left, right, keyOfL, keyOfR, type, config, sink, stats*)`
  泛型模板，行类型与键提取器可替换，结果通过回调流式输出，不在内部物化整表。
- `nestedLoopJoin(...)` 是 O(n*m) 的空值感知嵌套循环，输出多重集作为正确性基准。
- `JoinType`：`Inner / LeftOuter / RightOuter / FullOuter / LeftSemi / LeftAnti`。
- `SkewStrategy`：`SortMerge`（整分区排序归并）与 `SingleKeyStream`（重键逐个
  流式，剩余部分继续递归）。

## 执行流程

1. 顶层按 SQL 三值逻辑剥离 null 键行：null 永不等于 null，因此 null 行不参与
   匹配；仅在 outer/anti 需要保留时以未匹配行形式输出。
2. 非空行进入递归 grace 分区。若构建侧（right）行数不超过 `buildBudget`，直接
   建立内存哈希表并探测。
3. 超预算分区先统计构建侧键频：达到 `heavyKeyThreshold` 的键判为重键。
   - 无重键：用 `mixHash` 按递归层级混合哈希后，按 `partitionFanout` 再分区，
     逐层递归。
   - 有重键：按配置走排序归并或单键流式回退，`JoinStats` 记录回退次数与重键数。
4. `maxRecursionDepth` 兜底：哈希分布异常无法继续拆分时强制排序归并，保证终止。
5. 等值键以组（multiset）为单位发射：匹配组做笛卡尔积，半连接每个左行只出一次，
   反连接抑制匹配左行，outer 补齐未匹配侧，所有路径语义与嵌套循环完全一致。

## 构建与测试

```sh
cmake -S . -B build
cmake --build build
ctest --test-dir build --output-on-failure
```

`dataeng_test.cpp` 对六种连接语义、两种倾斜策略、递归分区、深度兜底、null 行及
200 组随机配置做差分测试：grace hash join 的结果多重集必须与嵌套循环基准逐行相同。

## 嵌入示例

```cpp
std::vector<dataeng::Row> left = {{1, 0}, {std::nullopt, 1}};
std::vector<dataeng::Row> right = {{1, 9}};
dataeng::JoinConfig cfg;
cfg.buildBudget = 1024;
dataeng::JoinStats stats;
dataeng::graceHashJoin(left, right, dataeng::JoinType::LeftOuter, cfg,
                       [](const dataeng::JoinPair& p) { /* ... */ }, &stats);
```

自定义行类型只需提供返回 `std::optional<int64_t>` 的键提取器（见测试中的
`OrderRow` 示例），哈希器也可通过模板参数替换。
