# pcapng 多接口时间归一

可嵌入 C++20 数据入口的 pcapng 解析与时间归一组件。解析 Section Header Block、
Interface Description Block 和 Enhanced Packet Block，并在不同 section、不同接口
之间做精确时间排序。

## 特性

- 每个 Section Header Block 单独识别 section byte order，大小端可逐 section 切换。
- Section 内 interface id 从 0 开始，跨 section 独立；EPB 的 interface id 只在本 section
  的 IDB 表中解析。
- 解析 `if_tsresol`（10 进制或 2 进制负幂）和 `if_tsoffset`（有符号 64 位秒偏移）。
- SHB、IDB、EPB 的所有 option 原样保留，包括未知 option 的 code、value 和 value padding。
- 时间换算全部使用整数有理数，不使用浮点排序：

```text
units  = 10^exponent        (decimal)
       = 2^exponent         (binary)
seconds = (raw_ticks + offset_seconds * units) / units
```

- 每个 packet 同时保留原始 64 位 tick、分辨率、offset、精确归一化时间，以及由 tick
  量化得到的 `[time, time + quantum)` 不确定区间，排序不改变这些字段。
- 跨接口/跨 section 排序使用精确有理数比较；时间完全相同时保持原捕获顺序。
- 对截断 block、长度不一致、非法 byte-order magic、未知 interface id 等返回
  `dataeng::PcapNgError`。

## 构建

```bash
cmake -S . -B build
cmake --build build
ctest --test-dir build --output-on-failure
```

`dataeng` 是普通 static library，直接把 `dataeng.hpp` 提供给调用方即可嵌入现有入口。

## 使用

```cpp
#include "dataeng.hpp"

#include <iostream>

auto document = dataeng::parse_pcapng_file("capture.pcapng");

for (const auto& packet : document.packets) {
    const auto& ts = packet.timestamp;
    std::cout << "raw=" << packet.raw_timestamp
              << " units/s=" << ts.units_per_second()
              << " offset=" << ts.offset_seconds()
              << " exact=" << ts.time().to_string() << " s\n";
}

// Exact cross-interface ordering.  packet.timestamp.raw_ticks(),
// resolution(), and offset_seconds() remain intact after sorting.
auto sorted = document.sorted_packets();
```

体量较大的入口可使用 `dataeng::ParseOptions{false}` 跳过 packet data 拷贝，
`captured_length` 和所有时间信息仍会保留。`parse_pcapng` 支持内存 span，另有
`parse_pcapng(std::istream&)` 和 `parse_pcapng_file(path)` 两种输入方式。

## 精度边界

为保持精确整数运算，支持 `10^-0` 到 `10^-19` 和 `2^-0` 到 `2^-63` 的接口分辨率。
时间分子使用有符号 128 位整数，足以容纳上述分辨率与 64 位 tick、64 位秒偏移的组合。
不支持的分辨率会作为格式错误拒绝，而不是退化为浮点或悄悄截断。

Simple Packet Block 和旧 Packet Block 没有 EPB 的 64 位时间戳语义，因此会按块长度安全跳过；
SHB/IDB/EPB 之外的未知 block 也按长度跳过。
