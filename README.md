# Zstandard seekable frame 读取

对象读取层需要可嵌入 C++ seekable Zstandard 索引库，解析 skippable seek table、frame compressed/decompressed size 与 checksum。索引条目总和须与实际 frame 边界一致，范围查询只解压必要 frame；损坏索引不回退为不受限扫描。

## 用法

```cpp
#include "dataeng.hpp"

// 解析并校验索引（损坏即抛 SeekableIndexError，绝不回退为全文件扫描）
dataeng::SeekableReader reader(std::move(file_bytes));

// 只解压与 [offset, offset+length) 相交的 frame
std::vector<std::byte> data = reader.readRange(offset, length);
```

`SeekableIndex::parse` 校验：skippable seek table（magic `0x184D2A5E`）必须
是文件末尾最后一帧；逐 frame 走查实际边界，索引的 compressed size 总和必须
精确落在 seek table 起始偏移；decompressed size 与 frame 头 content size 一致；
索引 checksum 与每帧尾部 checksum 一致。任何不符都抛 `SeekableIndexError`。

## 构建与测试

```sh
cmake -S . -B build && cmake --build build
cd build && ctest --output-on-failure
```

依赖系统 `libzstd` 运行库（无开发头文件，库内自行声明所需 C API 原型）。
