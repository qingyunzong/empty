# EDIFACT 交换控制号去重

EDI 接入层要嵌入可嵌入的 C++ EDIFACT 交换解析组件，识别 UNA 自定义分隔、UNB/UNZ、UNG/UNE 与 UNH/UNT 计数。控制号去重绑定发送方和语法版本；重复内容可幂等确认，不同内容冲突。组内坏消息隔离但交换计数必须核对。

## 用法

```cpp
#include "dataeng.hpp"

dataeng::ParseResult result = dataeng::parse_interchange(raw_edi);
if (result.ok()) { /* 无错误级问题 */ }

dataeng::InterchangeRegistry registry;
dataeng::DedupOutcome outcome = registry.submit(result.interchange);
// Accepted: 首次登记; Duplicate: 内容一致,幂等确认; Conflict: 控制号冲突
```

- `parse_interchange` 识别可选 UNA 服务串（自定义分隔符/释放字符），解析 UNB/UNZ、UNG/UNE、UNH/UNT 信封。
- UNT/UNE/UNZ 计数全部核对；计数不符或缺 UNT 的消息被隔离（`Message::isolated`），但仍参与组与交换层计数核对。
- `InterchangeRegistry` 以（发送方， 语法版本， 交换控制号）为键去重，内容指纹一致则幂等确认，不一致报冲突。

## 构建与测试

```sh
cmake -S . -B build && cmake --build build
ctest --test-dir build --output-on-failure
```
