存储引擎需要可嵌入的C++20动态哈希目录组件，在桶溢出时分裂并按需翻倍目录，处理溢出页与负载守恒。寻址前缀位数单调增加，分裂后两个桶的键划分不重不漏，目录项与桶的引用计数准确。用小键空间穷举分裂历史，对照朴素取模寻址核对每个键的归属与桶负载，分裂与查找交错时不访问错误桶。

## 组件

`include/dlks_formal/extendible_hash.hpp` 提供 header-only 模板
`dlks_formal::extendible_hash_directory<Key, Value, Hash>`：

- 目录大小为 2^global_depth，键按哈希值低 global_depth 位（寻址前缀）路由；
  global_depth 单调不减。
- 桶满时分裂：local_depth +1，按下一哈希位把键不重不漏地划分到孪生桶；
  local_depth == global_depth 时先翻倍目录。
- 达到 `max_depth` 上限后由桶内溢出页吸收冲突，目录不再增长。
- 每个桶维护引用计数，恒等于指向它的目录项数 2^(global_depth - local_depth)。
- 观测接口：`stats()` / `bucket_keys()` / `slot_owner()` / `split_history()`
  / `last_probe()`，供嵌入方与测试核对目录结构。

```cpp
dlks_formal::extendible_hash_directory<std::uint32_t, std::uint32_t> dir({4, 20});
dir.insert(key, value);
const auto* v = dir.find(key);
```

## 构建与验证

```sh
cmake -S . -B build && cmake --build build
ctest --test-dir build --output-on-failure
```

`tests/extendible_hash_test.cpp` 在小键空间上穷举全部插入序列（分裂历史），
每次插入后对照朴素取模寻址模型核对每个键的归属、桶负载守恒与引用计数，
并以 30 万次分裂/查找交错操作验证查找不会访问错误桶。
