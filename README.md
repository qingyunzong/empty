# Parquet / Dremel level 重建

`dataeng` 是一个无第三方依赖的 C++20 库，用于把 Parquet 风格的
repetition/definition levels 和 value stream 还原成逻辑的
`list` / `struct` / `null` 值。它既可以被湖仓读取器直接链接，也可以作为
独立的重建/编码组件使用。

## 语义

- `SchemaNode::Struct` 表示结构体，字段在 `children` 中。
- `SchemaNode::List` 恰好有一个 `children[0]` 表示元素 schema。元素自身
  可以是 required 或 optional，因此以下三种情况可以区分：
  - null list：`Value::is_null()`；
  - empty list：`is_array()` 且 `as_array().empty()`；
  - null element：数组元素 `is_null()`。
- `Presence::Optional` 增加一个 definition level；list 的 repeated 层隐式
  存在，增加一个 definition level 和一个 repetition level。这与 Parquet
  的三层 LIST 编码一致。
- `values` 只包含 definition level 达到该 leaf 最大 definition level 的
  事件。null 元素、空列表和 null 列表都只产生 level 事件，不消费 value。

例如 `optional list<optional int32>` 的 levels：

| 逻辑值 | repetition | definition |
|---|---:|---:|
| `null` | 0 | 0 |
| `[]` | 0 | 1 |
| `[null]` | 0 | 2 |
| `[7]` | 0 | 3 |

## 快速使用

```cpp
#include "dataeng.hpp"

using namespace dataeng;

SchemaNode schema = SchemaNode::root(
    "root",
    {SchemaNode::optional_list(
        "items",
        SchemaNode::optional_primitive("element", PrimitiveType::Int32))});

std::vector<Column> columns = {
    Column({"items"},  // list element name 可省略
           /*repetition_levels=*/{0, 1},
           /*definition_levels=*/{3, 2},
           /*values=*/{Value(std::int32_t{7})}),
};

std::vector<Value> rows = decode(schema, columns);
// rows[0]["items"] == [7, null]
```

列路径默认使用从 root 子节点到 primitive leaf 的完整名字。list 的隐式
repeated element 名可以省略；只要路径唯一，也支持用 list 字段名做前缀。
传入部分列即为投影读取，未提供的字段不会出现在结果中。

编码器可用于写入路径和测试：

```cpp
std::vector<Column> encoded = encode(schema, rows);
std::vector<Value> roundtripped = decode(schema, encoded);
```

## 错误处理

解码前会校验：

- repetition/definition 数组长度一致；
- level 在 `[0, max_level]` 内；
- 每条记录以 repetition 0 开始；
- `repetition <= definition`；
- value stream 中被 definition level 选中的数量与 values 数量一致。

非法序列抛出 `dataeng::DecodeError`，其中 `position()` /
`event_index()` 是出错列中零基的事件下标。value stream 短缺会在读取
`values` 之前报出首个缺值事件的位置；跨列行数、list 元素数或 struct
presence 不一致同样会报错。

## 构建与验证

```sh
cmake -S . -B build
cmake --build build
ctest --test-dir build --output-on-failure
```

测试会用小 schema 枚举所有合法结构（null/空列表/空元素/嵌套 list/struct
组合）做 encode -> decode 往返，并检查非法 level 序列的错误位置。
