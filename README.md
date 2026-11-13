# JSON Lines 多编码边界

日志采集器可嵌入的 C++20 JSON Lines 流式解码组件。它只负责记录分帧与
UTF-8 校验，不解析或改写 JSON 正文，保留的 `Record::text` 可以直接交给
任意 JSON 库。

## 用法

```cpp
#include "dataeng.hpp"

dataeng::Options options;
options.max_line_bytes = 4 * 1024 * 1024;

dataeng::JsonLinesDecoder decoder(options);
for (std::string_view chunk : chunks) {
    dataeng::Result result = decoder.feed(chunk);
    for (const auto& record : result.records) {
        parse_json(record.text);
    }
    for (const auto& error : result.errors) {
        log_bad_range(error.kind, error.begin, error.end, error.line);
    }
}

dataeng::Result tail = decoder.finish(); // 最后一条可以没有换行符
```

`decode_json_lines(input)` / `decode(input)` 是一次性处理完整缓冲区的便利
入口。`JsonlDecoder` 与 `Decoder` 是同一类型的别名。

## 边界语义

- 仅移除流首部一个 UTF-8 BOM（`EF BB BF`），BOM 可分块到达；不消费正文
  中出现的 BOM。`Record::begin`/`end` 是原始输入中的绝对字节偏移，`end`
  为开区间端点。
- 以 LF 分帧；记录末尾的 CRLF 会去掉 CR。最后一条无 LF 的记录在
  `finish()` 时输出。`\n` 转义（反斜杠加 `n`）只是普通正文字节，不参与
  分帧。
- UTF-8 校验允许二、三、四字节序列跨任意 `feed()` 边界。非法范围按
  Unicode maximal-subpart 规则报告：`Error::begin` 是包含端点，
  `Error::end` 是排斥端点。一个坏行会产生零个或多个 `InvalidUtf8` 错误，
  该行正文不输出，下一行仍正常解码。
- `max_line_bytes` 统计记录正文，不含 BOM 和行尾 CR/LF；设为 `0` 表示
  不限制。超限后立即释放已缓存前缀，并继续扫描到 LF 才产生一个
  `LineTooLong` 错误，因此不会为超长行保留正文，也不会丢失后续记录。
  可用 `pending_bytes()` 确认超限行没有正文缓存。
- 默认跳过空行（包括仅含 CR 的行）；设置 `skip_empty_lines = false`
  可保留空记录。

## 构建与测试

```sh
cmake -S . -B build
cmake --build build
ctest --test-dir build --output-on-failure
```
