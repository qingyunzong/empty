# dlks_formal

可嵌入的 C++20 头文件式 B+ 树与页管理组件。实现包含：

- 无读者锁的乐观查找，按 epoch 固定页生命周期。
- 父子锁耦合并发写；仅修改叶值时多个写者可在不同叶上并行。
- 叶页/内部页分裂、低占用借位与合并、根页塌缩。
- 页代号退役后进入隔离队列，确认旧读者 epoch 排空后才允许复用。
- 结构变更使用 undo 事务；根页替换与前后兄弟指针更新可回滚/恢复。
- 并发操作历史线性化检查器，以及完整结构不变量检查。

## 快速使用

```cpp
#include "dlks_formal.hpp"

dlks::BPlusTreeOptions options;
options.leaf_max_keys = 16;
options.internal_max_keys = 16;
options.page_capacity = 65536;

dlks::BPlusTree<int, std::string> tree(options);
tree.insert(7, "seven");
tree.upsert(7, "SEVEN");       // 已存在则替换，返回 false
tree.insert_or_assign(8, "8"); // 同 upsert

if (auto value = tree.find(7)) {
    // ...
}

tree.erase(8);

auto report = tree.check_invariants();
if (!report.ok) {
    // report.message 给出首个失败的不变量
}
```

`insert` 在键已存在时返回 `false`；`upsert` 返回是否为新插入。`find`
返回 `std::optional<Value>`。键按 `Compare` 严格排序，自定义比较器可直接作为
模板参数传入。

## 并发协议

读路径：

1. `find` 先取得 `EpochManager::ReaderGuard`。
2. 读取一次全局结构序号，要求为偶数。
3. 逐页读取不可变 `NodeData` 快照；页内版本号保证快照完整。
4. 返回前再次检查结构序号；若期间发生分裂、合并、根替换或清空，则重试。

叶值更新不会改变拓扑，读者可在旧/新不可变快照上线性化，无需等待写者。所有
`find` 均满足线性一致性；并发历史可用 `LinearizabilityChecker` 复核。

写路径：

- 普通插入/删除先持拓扑共享锁，按“父锁 → 子锁”顺序耦合，取得叶锁后释放父锁。
- 需要分裂、借位、合并或根替换时，升级为拓扑独占锁，并按根到叶顺序持锁完成事务。
- 结构事务提交前递增结构序号为奇数，提交/回滚后递增为偶数。

## 页代号与 epoch

`PageManager<Page>` 负责页对象和页代号：

```cpp
dlks::PageManager<int> pages(16);
dlks::page_id id = pages.create(42);

{
    auto guard = pages.pin();
    pages.retire(id);
    assert(pages.reclaim() == 0); // 旧读者仍固定页代号
}
assert(pages.reclaim() == 1);     // 复用安全
```

退役时 `EpochManager` 推进到新 epoch。只有所有 `epoch < retired_epoch`
的读者都离开后，页对象才被销毁、页代号才回到空闲表。B+ 树的结构事务自身也持有
reader guard，避免“提交后退役、但仍持有路径锁”造成的提前回收。

## 可恢复结构事务

结构变更记录每页的 before 镜像、根页 before id、新页列表和待退役页。事务未提交时：

- 恢复根页为 `root_before`。
- 逆序恢复叶页/内部页快照。
- 恢复兄弟页 `next`/`prev` 指针。
- 结构序号恢复为偶数。
- 新页进入 epoch 隔离队列，而不是立即删除。

可通过 `set_fault_injector` 在 `FaultPoint` 注入异常。默认自动回滚；设置
`auto_rollback_on_exception = false` 可保留未提交事务，随后显式调用
`recover()`：

```cpp
options.auto_rollback_on_exception = false;
tree.set_fault_injector([](dlks::FaultPoint p) {
    return p == dlks::FaultPoint::after_root_replace;
});

try {
    tree.insert(key, value);
} catch (const dlks::InjectedFault&) {
    auto recovery = tree.recover(); // 回滚根替换和兄弟指针更新
    assert(recovery.rolled_back);
}
```

本组件的 undo 日志是进程内结构一致性日志，不替代磁盘 WAL。需要落盘的引擎可在
同一 `FaultPoint`/事务边界对接自己的 redo/undo 存储。

## 验证

`check_invariants()` 检查：

- 所有内部页键严格递增，子页键落在分隔键区间内。
- 所有叶页深度一致，非根页满足最小占用，根内部页无单子页悬置。
- 叶链 `prev`/`next` 一致，所有可达叶恰好出现一次。
- 全叶链键严格递增且唯一。
- 叶条目数与逻辑 `size()` 一致，且无不可达存活页。

`OperationHistory` 与 `LinearizabilityChecker` 按 key 分解独立子历史，搜索满足
真实时序约束的顺序执行。测试会同时验证：

- 顺序/随机增删与 `std::map` 对照；
- 分裂、借位、合并、根分裂和根塌缩；
- 根替换、前后兄弟指针故障注入后的显式恢复；
- 8 线程并发读写下所有查找历史线性化；
- 并发结束后的全部结构不变量。

构建与运行：

```sh
cmake -S . -B build -DCMAKE_BUILD_TYPE=RelWithDebInfo
cmake --build build -j
ctest --test-dir build --output-on-failure
```

组件要求 `Key` 与 `Value` 可复制；页容量固定，容量耗尽时申请新页会抛出
`std::length_error`。`EpochManager` 当前提供 256 个并发 reader 槽位。
