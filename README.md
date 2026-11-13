# Arrow 字典数组跨批统一

列式交换层需要可嵌入的 C++ Arrow 字典统一组件，接收多批 dictionary、index、null bitmap 和 ordered 标志，生成全局字典与重映射索引。增量 delta 字典必须基于正确前代；索引溢出时升级位宽。稳定模式保持首次出现顺序，结果与解码后逐值比较一致。

## 组件

`dataeng.hpp` / `dataeng.cpp` 提供 `dataeng::BasicDictionaryUnifier<T>`（`StringDictionaryUnifier` 为字符串别名）：

- `AddBatch(DictionaryBatch<T>)`：摄入一批 `dictionary` + `indices` + 位打包 `null_bitmap` + `ordered` 标志，返回统一后批次槽位。
- `is_delta` 批次按 `dictionary_id` 追加到该 id 当前字典（前代）之后；无前代时抛 `UnifyError`，全量字典则替换前代。
- `GlobalDictionary()`：稳定模式下按首次出现顺序的全局字典；`batch(slot)` 给出重映射索引与物化 null bitmap。
- `width()`：当前索引位宽（int8→int16→int32→int64），字典增长时单调升级；`Indices<Int>(slot)` 按指定整型物化索引，位宽不足抛错。
- `Decode(slot)` 与 `DecodeBatch(batch)`：解码统一结果与原始批次，用于逐值比对一致性。

构建与测试：`cmake -S . -B build && cmake --build build && ctest --test-dir build`。
