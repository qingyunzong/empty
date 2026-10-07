# pgc — 页压缩归档工具

C++20 实现的键值记录页压缩库：记录按 `(key, version)` 排序，键做前缀压缩，
页分界按**压缩后实际字节预算**切分，单条记录超过预算即明确拒绝。

## 构建与测试

```sh
cmake -S . -B build
cmake --build build
ctest --test-dir build --output-on-failure
```

## 页格式

```
页头 (16 字节): magic "PGC1" | record_count u32 | crc32(payload) u32 | payload_size u32
条目: shared_prefix varint | suffix_len varint | suffix | version u64 | value_len varint | value
```

- 页内首条记录 `shared_prefix = 0`，后续记录与前一条共享前缀。
- 页预算覆盖页头 + 压缩后负载；加入新条目前按实际压缩尺寸判定是否换页。
- 单条记录压缩后仍超预算 → `RecordTooLarge` 错误，不产生任何输出。

## API（`include/pgc/page_compressor.hpp`）

- `build(records, {page_budget})` → `Archive{data, index}`；索引含每页首键、偏移、大小、CRC32。
- `decompress(archive)` → 校验每页校验和并还原原始记录（按 key、version 有序）。
- `build_and_publish(...)` / `publish(archive, path)` → 先写临时文件再原子 rename；
  构建或写入失败时目标路径不产生、不覆盖任何文件。
- `load(path)` / `serialize` / `deserialize` → 文件级 CRC32 校验。

## 测试覆盖（16 个 CTest 用例）

往返一致性、同键版本序、空前缀压缩收益、临界页大小（恰好放下 / 差一字节换页 /
单条记录恰好等于预算）、超大记录与超大键拒绝、页/文件校验和检错、
发布成功往返、失败发布不留文件且不破坏已有文件。
