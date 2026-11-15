# Parquet repetition/definition level 重建库

纯 C++20、无外部依赖、可嵌入的 Parquet 层级重建库。它把分片页中的
repetition/definition level 流还原为嵌套 `list`、`struct`、`map` 值，并提供
对应的编码器，使重建结果与公开的 Dremel/Parquet 嵌套参考编码互逆。

## 组件

- `schema.hpp` / `schema.cpp`：嵌套 schema 描述符。`Schema::makeStruct`、
  `makeList`、`makeMap`、`makePrimitive` 构造逻辑类型树；`freeze()` 计算每个
  节点的 `repLevel`、`defLevel` 与叶子的最大层级。
- `value.hpp` / `value.cpp`：嵌套值模型（null、bool、int64、double、string、
  struct、list、map），含深拷贝 `clone()` 与结构相等 `valuesEqual()`。
- `levels.hpp` / `levels.cpp`：核心编解码。
  - `LevelEncoder`：嵌套值 -> `LevelEntry{r,d,hasValue,value}` 列流。
  - `LevelDecoder`：分页 level 流 -> 嵌套值，跨页保持层级栈状态。
  - `RecordAssembler`：把各叶子列的解码结果按结构合并为完整记录。

## 层级语义

遵循 Parquet 逻辑类型（3-level LIST、MAP）与 Dremel 定义层级规则：

- repetition level：路径上每个 REPEATED 节点贡献一级，标记新元素从哪一层重复。
- definition level：路径上每个非 REQUIRED 节点贡献一级，编码实际存在的嵌套深度。

以 `optional list<optional string>` 为例（最大 def=3）：

| 数据 | r | d |
| --- | --- | --- |
| 存在元素 `"a"`、`"b"` | 0,1 | 3 |
| 空 list `[]` | 0 | 2 |
| null list | 0 | 1 |
| 含 null 元素的 list `["x", null]` | 0,1 | 3,2（null 元素带显式 null 标记） |

因此 null 容器、空容器、null 元素三者通过 definition level 与显式 null 标记
明确区分。MAP 的空 map 与 null map 同理（重复 key_value 组的层级）。

## 跨页与错误定位

`LevelDecoder::feedPage` 可多次调用，重复节点的栈帧在页之间保留，因此一条记录
可以横跨任意页边界。每条非法序列在第一次出现处即失败，`DecodeStatus` 给出
`globalIndex`（全局条目序号）、`pageIndex`、`indexInPage`，定位最早出错位置。
检测范围包括：

- rep/def 超出叶子最大层级；
- def 低于 rep；
- rep 找不到匹配的、仍打开的重复节点；
- 非可选（REQUIRED）节点收到 null；
- 带值条目出现在非最大 def 层级，或标记有值却无原语；
- 重复原语元素为 null、map key 为 null 等结构约束违规。

失败后解码器进入 failed 状态，后续 feed 直接返回错误，避免静默错位。

## 互逆性

`tests/test_levels.cpp` 覆盖：

- Parquet 规范 `backlink` 重复原语参考向量；
- null/空 list、null 元素、list-of-struct、list-of-list、map；
- 跨页拆分解码与最早错误位置；
- 60 行随机嵌套记录在所有叶子列上的 encode -> 分页 decode -> 再 encode 往返，
  断言 level 流与值结构都保持不变。

## 构建与测试

```sh
cmake -S . -B build
cmake --build build
ctest --test-dir build --output-on-failure
```
