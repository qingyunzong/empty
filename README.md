# dlks_formal

可嵌入查询执行器的 header-only C++20 哈希连接算子。它在固定内存预算下
对构建侧和探测侧做哈希分区，构建分区放不下时递归溢写；保留 SQL `NULL`
语义和重复键的完整笛卡尔结果，并对无法再切分的重键倾斜分区切换策略。

## 特性

- 单个头文件：`#include "dlks_formal.hpp"`，无运行时依赖。
- INNER JOIN 语义：键为 `std::nullopt` 的构建行和探测行都不参与匹配。
- 多重集语义：重复键的每一组构建/探测行对都会输出，不过滤、不去重。
- 构建侧和探测侧都按哈希分区；构建分区可在磁盘上递归再分区。
- 每个分区放得下时使用紧凑的开放桶哈希表，行内不重复保存键。
- 倾斜检测使用有界 space-saving 重频摘要；单个键组超过表容量时切换到
  “构建分块 + 重复扫描探测分区”的 block-hash 策略，仍然保持内存有界。
- 输出通过回调流式产生，不需要把结果整体放进内存。
- `join_stats` 提供溢写字节数、分区文件数、递归深度、倾斜分区数、输出
  行数和记账峰值内存。

## API

```cpp
#include "dlks_formal.hpp"

#include <cstdint>
#include <optional>
#include <vector>

struct build_row {
    std::int64_t key;
    std::uint32_t id;
};

struct probe_row {
    std::int64_t key;
    std::uint32_t id;
};

std::vector<build_row> build = {{1, 10}, {1, 11}, {2, 12}};
std::vector<probe_row> probe = {{1, 20}, {2, 21}};

dlks_formal::join_options options;
options.memory_budget_bytes = 64 * 1024;
options.partitions = 16;
options.partition_fanout = 16;
options.max_repartition_depth = 8;
options.spill_directory = "/path/to/scratch";

const auto key_of_build = [](const build_row& row) -> std::optional<std::int64_t> {
    return row.key;  // 返回 std::nullopt 表示 SQL NULL
};
const auto key_of_probe = [](const probe_row& row) -> std::optional<std::int64_t> {
    return row.key;
};

const auto stats = dlks_formal::hash_join(
    build, probe, key_of_build, key_of_probe,
    [](const build_row& left, const probe_row& right) {
        // 每个匹配对调用一次；引用只在本次回调期间有效。
        (void)left;
        (void)right;
    },
    options);
```

两侧键提取器相同时可使用四参数重载：

```cpp
dlks_formal::hash_join(build, probe, key_of_build, emit, options);
```

### 键类型

键提取器返回 `std::optional<K>` 时，`std::nullopt` 是 SQL `NULL`；返回普通
`K` 时视为永不为空。多列键可返回 `std::optional<std::tuple<...>>`，任一列
为空时整体返回 `std::nullopt`。

`K` 需要支持 `std::hash<K>`，或者是 `std::tuple`/`std::pair`/`std::array`
等 tuple-like 类型（逐元素组合哈希）。等值判断使用 `operator==`。

### 自定义行编码

默认 `spill_codec<Row>` 只接受可平凡复制（trivially copyable）的行，并按
原始字节落盘。包含 `std::string`、容器或拥有型指针的行需要特化：

```cpp
namespace dlks_formal {
template <>
struct spill_codec<my_row> {
    void encode(const my_row& row, std::vector<std::byte>& out) const;
    my_row decode(std::span<const std::byte> bytes) const;
};
}  // namespace dlks_formal
```

## 执行策略

1. **全内存快速路径**：构建侧行数不超过哈希表容量时，直接建立内存表并
   流式扫描探测侧，不创建溢写文件。
2. **初始哈希分区**：否则构建侧和探测侧按相同哈希位分到 `P` 个分区。
   分区缓冲区达到预算时追加写盘，单次调用只保留有界缓冲区。
3. **递归再分区**：处理某个分区时，如果构建侧仍超过表容量，则使用下一组
   哈希位和 `partition_fanout` 再分区；构建子分区和对应探测子分区一起
   生成，然后递归处理。
4. **倾斜回退**：如果 space-saving 摘要给出的重键下界已经大于表容量，
   说明一个键组本身无法被哈希再切分，直接切换为 block-hash：
   把构建分区按容量切块，每块建表后重新流式扫描探测分区并输出。每个构建
   行只属于一个块，因此结果仍是精确多重集。

## 内存记账

`memory_budget_bytes` 约束算子自己管理的：

- 分区缓冲区中的行；
- 哈希表的行数组、链式下标和桶头；
- 每分区的倾斜摘要；
- 为流式记录和小对象预留的固定余量。

`join_stats::peak_memory_bytes` 是上述记账峰值，并保证
`peak_memory_bytes <= memory_budget_bytes`。文件流自身的标准库内部缓冲区
不计入该值。默认编解码器下每行按 `sizeof(Row)` 记账；自定义编解码器若在
行内保存堆分配数据，需要自行把该部分纳入行大小模型。

预算过小时，算子会减少分区数、扇出和摘要槽位；若连一行哈希表都无法容纳，
会抛出 `std::invalid_argument`。

## 临时文件

未设置 `spill_directory` 时，根目录优先取环境变量 `TMPDIR`，否则取当前
工作目录。每次调用会在根目录下创建唯一的 `dlks-hash-join-*` 子目录，正常
返回时递归删除；`keep_spill_files = true` 可保留用于调试。系统共享 `/tmp`
不会被隐式使用。

## 统计字段

`join_stats` 中常用的字段：

- `build_rows` / `probe_rows`：两侧扫描到的总行数（含 NULL 键）。
- `build_null_keys` / `probe_null_keys`：因空键跳过的行数。
- `output_rows`：实际输出的匹配对数。
- `partition_files` / `spill_bytes`：创建的溢写文件数和写入字节数。
- `repartition_rounds` / `max_repartition_depth`：递归再分区轮次和最大深度。
- `skewed_partitions` / `skew_chunks`：切换到 block-hash 的分区数及构建块数。
- `peak_memory_bytes`：算子记账内存峰值。

## 构建与测试

```bash
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j
ctest --test-dir build --output-on-failure
```

测试内容包括：

- 随机构建/探测表（含 NULL 和重复键）与嵌套循环参考实现的排序多重集对照；
- 复合键任一列为 NULL 时不匹配；
- 重复键的完整笛卡尔积；
- 极端重键触发倾斜策略，并用嵌套循环核对多重集；
- 低预算下多轮递归分区仍与嵌套循环一致；
- 1 KiB 到 64 KiB 的多档预算扫描，逐档检查 `peak_memory_bytes <= budget`；
- 全内存快速路径不产生溢写文件。
- 非空普通键（非 `std::optional`）和自定义 `spill_codec`（含 `std::string`）
  也能正确溢写并匹配。

## 限制

- 构建侧需满足 `std::ranges::forward_range`，探测侧满足
  `std::ranges::input_range`。
- 行值需要可复制/可移动；默认溢写编码要求 trivially copyable。
- 回调中的行引用仅在回调执行期间有效；若需保留请自行复制。
- 输出顺序未定义，结果按多重集语义比较。
- 单次 `hash_join` 调用内部不共享可变全局状态，可并发调用不同实例。
