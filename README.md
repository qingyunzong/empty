# dlks_formal

可嵌入的 C++20 会话窗口状态组件，头文件为 `include/dlks_formal.hpp`。

## 语义

- 事件由键、时间戳和值组成；组件为每个输入事件分配单调递增的输入序号。
- 同一键的事件先按时间戳、再按输入序号稳定排序。
- 每个事件初始形成单点会话。相邻会话的距离 `right.start - left.end <= gap`
  时合并；距离恰好等于 `gap` 也合并。合并保留最早起始与最晚结束。
- 水位为 `W` 时，`timestamp == W` 的事件仍可接收，`timestamp < W` 的事件作为
  侧输出返回，且不能修改任何窗口。
- 会话在 `W > end + gap` 时关闭并输出。采用严格大于，是为了保证水位落在
  `end + gap` 时，该边界时刻的事件仍有机会参与合并。
- 关闭后的窗口不可变。关闭结果按 `(end, start, key)` 排序；成员按
  `(timestamp, sequence)` 排序。
- `window_result::aggregate` 是成员值的和。`Value` 需要支持默认构造和 `+`，
  `Key` 需要支持 `<`。
- `set_gap` 会重新划分当前仍开放的会话；已关闭的窗口不会被重新打开或修改。

## 使用

```cpp
#include "dlks_formal.hpp"

#include <cstdint>
#include <string>

int main() {
    dlks_formal::session_window_state<std::string, std::int64_t> state(5);

    static_cast<void>(state.process("user-a", 10, 3));
    static_cast<void>(state.process("user-a", 15, 4));  // gap 恰好相等，合并

    auto boundary = state.advance_watermark(20);         // end + gap，仍开放
    static_cast<void>(state.process("user-a", 19, 100)); // 19 < 20，侧输出

    auto closed = state.advance_watermark(21);
    // closed.closed[0]:
    //   key = "user-a", start = 10, end = 15,
    //   members = {(10, 3), (15, 4)}, aggregate = 7
}
```

`process` 和 `advance_watermark` 都返回 `step_result`：

- `closed`：本次操作关闭的窗口。
- `late`：本次操作产生的侧输出事件。

普通事件操作只可能产生侧输出；水位推进只可能关闭窗口。没有输入的组件在任意
次水位推进后都返回空结果。

## 构建与测试

```sh
cmake -S . -B build
cmake --build build
ctest --test-dir build --output-on-failure
```

测试使用 `tests/naive_session_model.hpp` 中完全独立的朴素状态机。参考模型不使用
被测组件的会话合并或窗口生成逻辑，而是每次水位推进时按键重新排序、从头分组。
测试包含：

- `gap` 恰好相等与 `gap + 1` 的边界；
- 输入全排列下的合并与不合并；
- 多窗口级联合并；
- 水位边界接收、侧输出和关闭窗口不可变；
- 空输入；
- 32 个确定性随机种子、每个 500 次操作的逐事件/逐水位差分。
