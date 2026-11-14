# EDIFACT UNA 动态语法

供应链采集器要可直接接入 C++ EDIFACT 解析库，支持 UNA 指定服务字符、release 转义、UNB/UNZ 与 UNH/UNT 计数。段终止符可跨块，被 release 的终止符属于数据；消息失败隔离到对应 UNT，interchange 计数仍按实际消息核对。

## `dataeng` 流式 EDIFACT 解析库

`dataeng::EdifactParser` 是一个 push 式、无第三方依赖的 C++20 解析器，面向
供应链采集器按块接收报文的场景。

### 能力

- **UNA 动态服务字符**：读取 UNA 的六个字符（组件分隔符、元素分隔符、小数
  点、release、重复分隔符、段终止符），并立即对后续报文生效；缺省采用
  UN/EDIFACT 语法级 4 的 `: + . ? * '`。
- **release 转义**：release 之后的任意字节（含段终止符、各分隔符和 release
  自身）按字面数据处理；元素/组件切分同样识别 release，`Component::value`
  为去转义值，`raw` 保留原始 release 文本。
- **流式跨块**：`feed()` 可接收任意大小的字节块，段终止符与 release 序列允许
  被切分到相邻块中；状态机逐字节推进，不要求整段或整报文驻留。
- **信封/消息计数**：
  - UNT 的 DE 0074 与该消息实际段数（含 UNH、UNT）核对；
  - UNZ 的 DE 0030 与 interchange 内实际 UNH 数量核对，DE 0020 与 UNB
    DE 0020 控制引用核对。
- **失败隔离**：消息级错误（如 UNT 计数不符、孤儿 UNT）只标记当前消息，解析
  在其后的消息与 interchange 信封上继续；interchange 计数始终按实际解析出的
  消息核对，不被失败消息影响。

### 接入示例

```cpp
#include "dataeng.hpp"

using namespace dataeng;

ParseCallbacks cb;
cb.on_interchange_start = [](const InterchangeInfo& ic) { /* ... */ };
cb.on_interchange_end   = [](const InterchangeInfo& ic) { /* 含 actual/declared 计数 */ };
cb.on_message_start     = [](const MessageInfo& msg) { /* ... */ };
cb.on_message_end       = [](const MessageInfo& msg) { /* msg.failed 标记隔离的失败 */ };
cb.on_segment           = [](const Segment& seg) {
    if (seg.tag == "DTM") {
        std::string code = seg.elements[1].components[0].value;
    }
};
cb.on_error             = [](const ParseError& err) { /* 采集器错误通道 */ };

EdifactParser parser(cb);
for (auto chunk : network_reader()) {
    parser.feed(chunk);          // 跨块安全
}
bool clean = parser.finish();    // 报告悬挂的消息/interchange
```

### 构建与测试

```sh
cmake -S . -B build
cmake --build build
ctest --test-dir build --output-on-failure
```

测试覆盖：UNA 缺省与自定义字符、release 转义终止符/分隔符、跨块终止符、
UNT/UNZ 计数不符、UNZ 引用不符、消息失败隔离、孤儿 UNT、截断报文、同一流中
多个 interchange 等场景。
