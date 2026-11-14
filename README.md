# dataeng

可嵌入的 C++20 syslog 流解帧器，按显式配置的 RFC 6587 方式完成分帧：

- **octet-counting**：`MSG-LEN SP SYSLOG-MSG`
- **non-transparent**：`SYSLOG-MSG LF`

实现是 header-only 的（`#include "dataeng.hpp"`），`dataeng.cpp` 仅用于保留现有
CMake 库目标。解析器不依赖网络、日志库或线程库，内部不做同步。

## 使用

```cpp
#include "dataeng.hpp"

dataeng::SyslogDeframer deframer(dataeng::FramingMode::OctetCounting);

auto frames = deframer.feed(chunk, received_at);
for (const auto& frame : frames) {
    consume(frame.message(), frame.stream_begin, frame.stream_end, frame.received_at);
}

while (auto error = deframer.next_error()) {
    log(error->code, error->stream_begin, error->detail);
}
```

也可使用队列接口：

```cpp
deframer.feed(chunk, received_at);
while (auto frame = deframer.next()) {
    // ...
}
```

`feed()` 返回本次调用新增的帧，同时这些帧也留在 `next()`/`poll()`/`pop()` 队列中。
常用别名：`SyslogStreamDeframer`、`SyslogFramer`、`Deframer`。模式可通过构造函数、
`set_framing_mode()` 或 `Config` 明确指定，不会自动猜测。

## 帧元数据

每个 `Frame` 既是原始字节的副本，也带绝对流位置：

- `raw_bytes` / `raw()`：完整原始帧，包含长度前缀或尾部 LF
- `stream_begin`、`stream_end`：原始帧在输入流中的 `[begin, end)` 范围
- `message_begin`、`message_end`：去掉 RFC 6587 分帧字节后的 `SYSLOG-MSG` 范围
- `received_at`：完成该帧的 chunk 的接收时间
- `first_received_at`：该帧首字节所在 chunk 的接收时间
- `framing`：实际使用的分帧方式

即使帧跨多个 chunk，位置始终是相对整个 stream 的绝对字节偏移。

## RFC 6587 规则与恢复

- octet-counting 的长度前缀可以跨任意多个 `feed()` 调用；只有看到终止 `SP`
  后才决定前缀是否合法。
- 前缀必须是十进制最短合法形式：首字符为 `1`-`9`，不得有前导零；`0`、`+12`、
  `012 `、空长度前缀都会被拒绝。
- 长度按 `SYSLOG-MSG` 的字节数计算。消息内的 `LF` 只是消息内容，不切帧。
- non-transparent 模式以单个 `LF` 结束帧，`LF` 不属于消息内容。
- 已知但非法的长度（例如前导零、超过 `max_message_size`）会按声明长度精确
  跳过整个坏帧，之后立即回到帧边界。
- 无法确定长度的坏前缀不会猜测消息内部边界：丢弃到下一个 `LF`，随后只有
  在行首再次看到完整数字前缀时才恢复解析。也可通过 `resync()` 在外部传输
  给出的可靠边界处丢弃残留状态。
- `Config::recover_at_record_boundary = false` 会让解析器在首个错误后停止，
  由调用方调用 `reset()` 显式恢复。

错误通过 `next_error()` 返回，包含 `ErrorCode`、坏帧起始位置、检测位置、
已解析长度及接收时间。错误路径不会产生半帧。

## 配置

```cpp
dataeng::Config config;
config.framing = dataeng::FramingMode::OctetCounting;
config.max_message_size = 1024 * 1024; // 0 表示不限制
config.max_length_digits = 20;
config.emit_empty_frames = true;
config.recover_at_record_boundary = true;

dataeng::SyslogDeframer deframer(config);
```

非 transparent 模式默认把空行作为零长度消息帧返回；若上游不允许空消息，可将
`emit_empty_frames` 设为 `false`，此时空行会产生 `EmptyFrame` 错误。

## 构建与测试

```sh
cmake -S . -B build
cmake --build build
ctest --test-dir build --output-on-failure
```
