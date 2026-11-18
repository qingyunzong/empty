# dlks_formal

可嵌入的 C++20 并发跳表，用于缓存索引场景。实现只有
`include/dlks_formal.hpp` 一个头文件，不依赖第三方库。

## 快速使用

```cpp
#include "dlks_formal.hpp"

dlks_formal::ConcurrentSkipList<std::string, std::uint64_t> index(
    0x1234abcdULL);  // 层数随机流使用确定种子

index.insert("cache/a", 7);
index.insert("cache/b", 9);

if (auto value = index.find("cache/a")) {
    use(*value);
}

index.erase("cache/b");
index.reclaim_epochs();  // 可选的显式回收点
```

默认值类型为 `std::monostate`，也可以只把跳表当作有序键集合使用。

## API

```cpp
template <class Key,
          class Value = std::monostate,
          class Compare = std::less<Key>,
          std::size_t MaxHeight = 20,
          class Allocator = std::allocator<std::byte>>
class ConcurrentSkipList;
```

- `insert(key, value) -> bool`：键不存在时插入；并发插入同一键只有一个返回 `true`。
- `erase(key) -> bool` / `remove(key)`：逻辑删除成功时返回 `true`。
- `find(key) -> std::optional<Value>` / `lookup(key)`：并发安全、无锁读。
- `contains(key) -> bool`
- `size()` / `empty()`：写入静默后精确，并发期间是近似值。
- `snapshot()` / `keys()`：返回按键升序的值或键快照。
- `validate_structure()`：检查所有层的严格有序、键唯一、层成员关系、删除标记和计数。
- `heights()`：诊断用，返回当前键和塔高。
- `reclaim_epochs()`：强制回收调用线程自己的退役批次；删除达到批次阈值时也会自动回收。

命名别名包括 `SkipList`、`LockFreeSkipList`、`EpochSkipList` 和
`ConcurrentSkipListMap`。

## 并发设计

- 底层链表是唯一权威的有序集合。上层仅作为读路径的乐观索引，最终判断在底层完成。
- 插入使用 Harris 风格指针 CAS；删除先标记底层后继指针，再从所有层物理摘除。
- 节点只有在所有层都不再可达后，才进入 retired 列表。
- 每个读者在访问链表前发布纪元；回收器只释放早于所有活跃读者纪元的节点。
  因此被删节点的内存不会在读路径仍可能持有其指针时重用。
- 退役节点按线程本地批次回收，避免无锁回收栈的 ABA；容器析构时清空各线程剩余批次，
  因此线程退出后遗留的批次会在容器析构时释放。
- 上层塔在底层发布前构建，未完成发布的塔可被读路径安全跳过，不会阻塞其他插入。
- 层级使用 SplitMix64 和构造时种子生成，删除概率为 1/4。同一插入序列和种子产生相同塔高。

容器析构要求所有线程已停止访问，和标准容器一样。

## 测试

```sh
cmake -S . -B build -DCMAKE_BUILD_TYPE=RelWithDebInfo
cmake --build build -j
ctest --test-dir build --output-on-failure
```

测试覆盖：

- 单线程随机操作历史对照确定性单线程跳表模型，逐步检查查找结果、键值快照和塔高布局。
- 相同种子产生完全相同的层高流，不同种子产生不同层高流。
- 多线程同键插入/删除竞争：每轮恰好一个插入和一个删除成功。
- 多线程不同键的塔插入/摘除，逐阶段验证每层可达性、顺序和唯一性。
- 并发操作区间记录的线性化检查（按实时先后约束回溯）。
- 写者、读者和快照交错运行后，最终结构与单线程模型一致。
- 自定义分配器与阻塞值类型验证：读者仍持有旧纪元时，删除节点的内存不会被释放；
  读者退出后同一节点才被回收。

建议在 ASan/UBSan 和 TSan 下重复运行测试。
