# EDI X12 控制号对账

可嵌入的 C++20 X12 envelope 状态机。它按字节流增量消费数据，适合直接挂在交换数据入口上；不要求一次拿到完整文件，也不依赖固定换行或固定分块。

## 能力

- 从固定 106 字节 ISA 推导 element、repetition、component 和 segment 分隔符。
- 校验 ISA/IEA、GS/GE、ST/SE 三层控制号与声明计数：
  - `ISA13 == IEA02`
  - `GS06 == GE02`
  - `ST02 == SE02`
  - `GE01` 等于组内实际 `ST` 数
  - `SE01` 等于 `ST` 到 `SE`（含首尾）的实际段数
  - `IEA01` 等于 interchange 内实际 `GS` 数
- 功能组和 transaction 可跨任意 feed 分块。
- 按 `sender + ISA13` 去重重复 interchange；重复项进入 `duplicates`，不会重复产生 group/transaction。
- 局部 transaction 失败只影响该 transaction 的结论，解析器继续校验 GE/IEA，所有层级的诊断都会保留。
- 输出 `stream -> interchange -> group -> transaction` 层级证据，并可直接序列化为 JSON。

## 嵌入

```cpp
#include "dataeng.hpp"

dataeng::EnvelopeStateMachine parser;

parser.feed(first_chunk);   // 可以是任意字节边界
parser.feed(second_chunk);
parser.finish();

const dataeng::ParseResult& report = parser.result();
if (!report.ok()) {
    for (const auto& issue : report.diagnostics) {
        // issue.level / issue.severity / issue.code / issue.segment /
        // issue.location / issue.expected / issue.actual
    }
}
```

一次性解析也可以直接使用：

```cpp
auto report = dataeng::parse(bytes);
auto json_evidence = report.to_json();
```

## 报告结构

- `ParseResult::interchanges`：已接受的 interchange。
- `ParseResult::duplicates`：按 sender+control 判定为重复、未重复处理的 interchange。
- `ParseResult::diagnostics`：所有层级诊断的扁平视图，顺序即发现顺序。
- `Interchange::groups[*]::transactions[*]`：结构化证据；每层都有 `diagnostics`、`complete`、`envelope_valid`、`valid` 和源位置。

`envelope_valid` 只描述当前层 envelope 是否有效；`valid` 会继续吸收下层失败。因此 transaction 的 SE 错误不会抹掉 interchange 层的 IEA 结论，反之亦然。

## 选项

`EnvelopeStateMachine::Options` 可关闭某类校验或去重：

```cpp
dataeng::EnvelopeStateMachine::Options options;
options.deduplicate_interchanges = true;  // 默认开启
options.validate_controls = true;          // 默认开启
options.validate_counts = true;            // 默认开启
options.validate_isa_layout = true;        // 默认开启
options.ignore_leading_whitespace = true;  // 默认开启
```

## 构建与测试

```sh
cmake -S . -B build
cmake --build build
ctest --test-dir build --output-on-failure
```
