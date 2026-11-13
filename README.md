# Bloom filter 分区裁剪合并

湖仓元数据层需要可嵌入 C++ blocked Bloom filter 库，格式固定 hash、salt、block selection 和 bit endianness。只合并参数完全相同的过滤器，序列化跨平台一致；过滤器用于裁剪时绝不产生假阴性。用已插入值、未插入值和损坏尾块核对。

## 格式（固定，跨平台一致）

- Hash：FNV-1a-64 后与固定 salt 异或，经 splitmix64 混合。
- Salt：编译期常量 `BlockedBloomFilter::kSalt`。
- Block selection：`(hash 高 32 位 * num_blocks) >> 32`；每块 256 bit（8 个 uint32）。
- Bit endianness：字内小端（bit b 为 `(word >> b) & 1`），序列化整数全部小端。
- 序列化：magic `BBF1` + version + salt + num_blocks + block_bits + payload 长度 + payload 的 CRC-32，随后是 payload。长度不符或校验失败（如损坏/截断的尾块）一律反序列化失败。

## 使用

```cpp
dataeng::BlockedBloomFilter f(1024);   // 唯一参数：块数
f.insert("partition=2026-11-14");
bool hit = f.may_contain("partition=2026-11-14");  // 已插入绝不漏判
dataeng::BlockedBloomFilter g(1024);
bool ok = f.merge(g);                  // 参数不同返回 false 且不修改 f
auto bytes = f.serialize();
auto back = dataeng::BlockedBloomFilter::deserialize(bytes);  // 失败返回 nullopt
```

## 测试

```sh
cmake -S . -B build && cmake --build build && ctest --test-dir build --output-on-failure
```
