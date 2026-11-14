# Arrow dictionary delta 世代

列式流接收器要可嵌入 C++ Arrow IPC dictionary 管理器，按 dictionary id、isDelta 与 record batch 顺序维护不可变世代。替换字典不能改变已排队 batch 的索引含义，delta 越界拒绝；多个字段共享 id 时类型必须一致。随机切块消息与完整流产生同一数组。

## 实现

`dataeng.hpp` 是 header-only、无外部依赖的 C++20 实现，核心类型如下：

- `DictionaryManager`：按 `(dictionary id, generation)` 保存不可变快照。完整字典创建新世代，`isDelta=true` 在旧快照基础上追加；旧批次持有入队时的共享快照，后续替换不会改变其索引含义。
- `RecordBatch` / `Array`：字典列保存索引与快照。`Decoded()` 可物化为值数组，`ToStrings()` 便于比较。
- `StreamReceiver`：既可 `Push(Message)`，也可 `Feed` 任意切块字节。自动识别内置 DENG 分帧或标准 Arrow IPC stream。
- `ArrowIpcReader`：最小 FlatBuffers 读取层，支持 Schema、DictionaryBatch、RecordBatch、EOS，以及常见整数、浮点、字符串、二进制和字典索引类型。

错误以 `Status` 返回。`AddDelta` 在缺少基础字典、显式偏移不等于当前字典末尾、或字典值类型不一致时拒绝；记录批次中任一非空索引超出当前快照范围时返回 `OutOfRange`，且不会入队。`RegisterSchema` 对共享同一 id 的字段校验值类型与索引类型，失败时不注册该 schema。

## 使用

```cpp
using namespace dataeng;

DictionaryManager manager;
manager.RegisterSchema(Schema{Field("color", DataType::Utf8(), 7,
                                     DataType::Int32())});
manager.AddDictionary(7, Array::FromUtf8({"red", "green"}));
manager.AddRecordBatch(RecordBatch(
    manager.schema(), {Array::FromInt32({0, 1})}));

// 新世代不改变已入队批次的索引含义。
manager.AddDictionary(7, Array::FromUtf8({"blue", "black"}));
manager.AddRecordBatch(RecordBatch(
    manager.schema(), {Array::FromInt32({1})}));
```

流式输入：

```cpp
StreamReceiver receiver;
for (auto chunk : chunks) {
  if (!receiver.Feed(chunk).ok()) break;
}
for (const RecordBatch& batch : receiver.batches()) {
  for (const std::string& value : batch.column(0).ToStrings()) {
    // ...
  }
}
```

## 构建测试

```sh
cmake -S . -B build
cmake --build build
ctest --test-dir build --output-on-failure
```
