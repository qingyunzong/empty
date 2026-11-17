# dlks_formal

可嵌入的 C++20 列页编码组件，单头文件、无外部依赖。支持 `plain`、`dictionary`、`RLE`
和 `delta` 四种物理编码，按包含头部、null 位图、编码元数据和填充的精确页大小选择编码。

```cpp
#include "dlks_formal.hpp"

using namespace dlks_formal;

Column<std::uint32_t> column(1000);
for (std::size_t i = 0; i < column.size(); ++i) {
    column.values[i] = static_cast<std::uint32_t>(i);
}
column.nulls.set_null(42); // 1 means NULL

const Encoding chosen = choose_encoding(column);
const auto estimates = estimate_encodings(column); // all four, exact byte counts
const ColumnPage<std::uint32_t> page = encode_column(column);

const std::uint32_t value = page.value_at(900); // random access
const bool is_null = page.is_null(42);
const Column<std::uint32_t> decoded = page.decode(); // naive/full decode
```

## 编码与随机访问

- `Plain`：原始值顺序存放，随机访问 `O(1)`。
- `Dictionary`：首现顺序字典值加定宽索引，随机访问 `O(1)`。
- `RLE`：游程值和位打包游程长度；解析时建立累计游程末端表，随机访问 `O(log runs)`。
- `Delta`：绝对检查点加 zigzag 编码的模 2^N 差分；每 32 行一个检查点，随机访问最坏
  `O(32)` 次加法。

null 位图按 1 bit/行存放，`1` 表示 NULL。所有编码都保留 null 槽位下的原始值，因此编码、
回退和解码不会改写列内容；逻辑读取使用 `at()` 得到 `std::optional<T>`，需要检查隐藏值时
使用 `value_at()`。

## 精确估算

`EncodingEstimate` 将总大小拆成：

```text
total_bytes = header_bytes + null_bitmap_bytes + metadata_bytes
            + value_bytes + alignment_bytes
```

- 固定页头为 64 字节，包含编码、行数、各段偏移和编码参数。
- 仅当存在 NULL 时写入 `ceil(rows / 8)` 字节的 null 位图。
- 字典值、RLE 游程值、delta 检查点计入 `metadata_bytes`。
- 位图之后的 payload 按 8 字节对齐，页尾也补齐到 8 字节；两处填充均计入
  `alignment_bytes`。

估算与写入共用同一布局函数，测试逐编码断言 `estimate.total_bytes == page.encoded_size()`。
选择时取总字节数最小者；相等时依次偏好 `plain`、`RLE`、`dictionary`、`delta`。

## 失败回退

`encode_column` 在选中编码构造失败时回退到 `plain`（自动模式下会按估算顺序尝试后续编码）。
每次尝试都写入独立临时缓冲区，完整构建并通过页校验后才替换目标页。`encode_into` 因此提供
强异常保证：失败不会留下半页数据，也不会改变目标页原有内容。

`EncodeOptions` 可限制总页字节数、字典条目数或 RLE 游程数；达到限制时按同一回退路径处理。
force 编码失败时固定回退到 `plain`。

## 验证

```sh
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build
ctest --test-dir build --output-on-failure
```

测试覆盖 8/16/32/64 位有符号和无符号整数，使用确定性随机生成的随机、常量、低基数、单调、
游程、交替和窄值列；对每种编码比较精确估算与实际页大小、完整解码与原始列、随机访问与朴素
数组访问，并覆盖 null 位图、极值、delta 检查点、失败回退强保证和损坏页拒绝。

页格式使用固定小端序字段，可直接持久化或在进程间传递；`ColumnPage<T>::from_bytes()` 会校验
魔数、版本、类型宽度、段偏移、游程覆盖和总大小。
