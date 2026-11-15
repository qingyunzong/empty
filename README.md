# dataeng — 可嵌入的流式 MIME 解析库

`dataeng` 是一个无外部依赖的 C++20 MIME 流解析库，面向邮件采集管线。消息可以按任意
大小的块喂入，解析器保持状态，不需要把整封邮件驻留在内存中。

## 能力

- 递归解析嵌套 `multipart/*`，通过 `depth` 暴露层级。
- 折叠头（RFC 5322 obs-fold）展开；头字段保留原始字节范围。
- boundary 可以跨任意 `feed()` 块，支持 CRLF 与 LF 行尾。
- `7bit` / `8bit` / `binary` 透传，`base64`、`quoted-printable` 增量解码。
- `Content-Disposition` / `Content-Type` 文件名参数，支持 RFC 2231
  `filename*=`、`filename*0*=` 续接、百分号解码，以及 UTF-8、ISO-8859-1、
  Windows-1252 字符集；同时兼容常见的 RFC 2047 编码字文件名。
- 每个 part 的 `body_range` 是原始消息中的精确半开区间 `[begin, end)`。
- 损坏的 part 只影响自身：解码错误会记录 `PartError`，解析器继续扫描到父
  boundary，后续 sibling 仍然正常交付。
- 可配置最大嵌套深度、part 数、头大小/行数/行长、boundary 长度、单 part
  解码字节数、全消息解码字节数、解码膨胀比和输入总字节数。

## 快速使用

```cpp
#include "dataeng.hpp"
#include <cstdio>

class Sink final : public dataeng::Sink {
 public:
  void on_part_begin(const dataeng::PartInfo& part) override {
    std::printf("part %zu depth=%zu type=%s\n", part.index, part.depth,
                part.media_type.c_str());
  }

  void on_part_data(const dataeng::PartInfo& part,
                    std::span<const std::uint8_t> data) override {
    // 流式输出，data 只在本次回调期间有效。
    (void)part;
    (void)data;
  }

  void on_part_error(const dataeng::PartInfo& part,
                     const dataeng::PartError& error) override {
    std::printf("part %zu error=%s source=[%llu,%llu)\n", part.index,
                dataeng::to_string(error.code),
                static_cast<unsigned long long>(error.range.begin),
                static_cast<unsigned long long>(error.range.end));
  }
};

dataeng::Limits limits;
limits.max_depth = 16;
limits.max_decoded_part_bytes = 32ull * 1024 * 1024;

Sink sink;
dataeng::MimeParser parser(sink, limits);
while (/* 从网络/文件读取一块 */ false) {
  parser.feed(/* bytes, size */);
}
parser.finish();
```

`dataeng::collect()` / `dataeng::parse_message()` 是保留全部解码 body 的便捷封装，
适合测试或小附件；大附件应直接使用 `MimeParser` + `Sink`。

## 事件与恢复语义

每个 part（包括 root 和 multipart 容器）按先序遍历触发：

1. `on_part_begin(const PartInfo&)`
2. 叶子 part 的零到多次 `on_part_data(part, span)`
3. 发现错误时 `on_part_error(part, error)`
4. `on_part_end(const PartInfo&)`，此时 `body_range` 已最终确定

消息结束时触发一次 `on_message_end(const MessageResult&)`。

解码错误不会让整封邮件失败。例如 base64 中出现非法字符时：

- 非法字符的原始位置记录在 `PartError::range`；
- 该 part 的完整编码 body 记录在 `PartInfo::body_range`；
- `PartInfo::truncated` 为 `true`，`PartInfo::complete()` 为 `false`；
- 解析器跳过非法字符并继续寻找 boundary，其他 sibling 照常交付。

`PartError` 的 range 使用输入流绝对偏移（从第一次 `feed()` 的第一个字节开始）。

## 限额

`dataeng::Limits` 的默认值：

| 字段 | 默认值 | 说明 |
| --- | ---: | --- |
| `max_depth` | 32 | root 深度为 0；超限的 multipart 作为不透明叶子交付并报错 |
| `max_parts` | 10000 | 超限 part 只扫描不交付 |
| `max_header_bytes` | 256 KiB | 头块上限 |
| `max_header_count` | 1000 | 头字段数上限 |
| `max_header_line_bytes` | 16 KiB | 单个物理头上限 |
| `max_boundary_length` | 200 | boundary 参数上限 |
| `max_decoded_part_bytes` | 64 MiB | 单叶子 part 解码输出上限 |
| `max_total_decoded_bytes` | 512 MiB | 全消息解码输出上限 |
| `max_expansion_ratio` | 64 | 输出/输入膨胀比保护 |
| `max_message_bytes` | 1 GiB | 接收输入上限，0 表示不限制 |

达到解码上限时只截断后续输出，仍继续扫描到 boundary，不会丢失 sibling。

## 构建与测试

```sh
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j
ctest --test-dir build --output-on-failure
```

测试覆盖：逐字节喂入、boundary 跨块、嵌套 multipart、折叠头、RFC 2231
续接与字符集、base64/quoted-printable、损坏附件的字节范围、深度限制和
解码大小限制。
