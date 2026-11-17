# dlks_formal

可嵌入的 C++20 虚拟块设备映射组件。固定容量、无堆分配、无异常，只依赖标准库。

## 核心语义

- **多级写时复制快照**：快照构成一棵树。创建快照只写入元数据，初始状态全部继承父快照，物理块保持共享。
- **惰性冻结**：父快照修改某个 LBA 前，先把该 LBA 的旧有效映射推入所有仍在继承该槽位的直接子快照。子快照随后拥有局部映射，父快照的后续写入不会改变子快照的读值。
- **覆盖写先分配后切换**：`begin_write` 保留一个新物理块并复制旧值，`stage` 写入完整新值，`prepare` 落盘紧凑 redo 记录；只有 `commit`/`recover` 才通过一次状态交换发布映射。
- **崩溃安全**：prepare 之前的崩溃丢弃暂存块，读值仍为旧值；prepare 之后的崩溃由 `recover()` 重放。不存在指向半初始化块的可见映射。
- **引用计数**：每个块的引用数等于所有存活快照局部块槽位的数量。块从映射中移除时立即减引用，归零后回收。
- **discard**：在目标快照写入 `zero` 标记，遮蔽父快照中的块；读值为 0，旧块按引用计数释放。
- **删除父快照**：把被删快照的局部块/zero 槽位转移给仍处于继承状态的直接子快照并增加引用，然后重挂父指针、释放被删快照自身的引用。继承自祖父的槽位无需搬运，直接重挂即可。

## 快速使用

```cpp
#include "dlks_formal.hpp"

using Store = dlks::cow_mapping<std::uint32_t,
                                /*LBAs=*/16,
                                /*snapshots=*/8,
                                /*blocks=*/64>;

Store store;
auto root = store.root();

store.write(root, 0, 42);
auto snap = store.create_snapshot(root);

store.write(root, 0, 99);       // COW: root 分配新块
assert(store.read(root, 0) == 99);
assert(store.read(snap, 0) == 42);  // 快照隔离

store.discard(snap, 0);         // 该快照中该 LBA 变为 0
assert(store.read(snap, 0) == 0);

auto doomed = store.create_snapshot(root);
store.delete_snapshot(doomed);  // 非根快照可删除，子快照会继承其映射
```

两阶段写和崩溃恢复：

```cpp
auto snap2 = store.create_snapshot(root);
auto txn = store.begin_write(snap2, 0); // 分配新块并复制旧值
txn.stage(123);                        // 写入完整新值
txn.prepare();                         // redo 记录持久化

// 此时崩溃：映射仍是旧值，不会看到半写映射
txn.crash();
assert(store.journal_pending());
assert(store.read(snap2, 0) == 99);

store.recover();                       // 原子重放 redo 记录
assert(store.read(snap2, 0) == 123);
```

`commit()` 等价于 `prepare()` 后原子发布；未 prepare 的事务可以用 `abort()` 丢弃。事务析构按进程死亡处理：未 prepare 的暂存消失，已 prepare 的 redo 记录留给 `recover()`。

## 主要 API

| 接口 | 说明 |
| --- | --- |
| `root()` | 根快照 id |
| `create_snapshot(parent)` | 创建子快照；容量满返回 `no_snapshot` |
| `read(snap, lba)` / `read(snap, lba, out)` | 解析继承链读取；空洞和 discard 返回 0 |
| `write(snap, lba, value)` | 一次性提交的 COW 覆盖写 |
| `begin_write` / `stage` / `prepare` / `commit` / `abort` / `crash` | 两阶段写与崩溃注入 |
| `discard(snap, lba)` | 写入 zero 标记并释放本快照局部块引用 |
| `delete_snapshot(snap)` | 删除非根快照并转移共享块 |
| `recover()` | 重放已 prepare 的 redo 记录 |
| `refcount(block)` / `block_allocated` / `block_value` | 块状态观测 |
| `inspect_slot` / `resolve_block` | 局部槽位和有效块观测 |
| `check_invariants(error)` | 校验快照树、槽位、块分配与引用守恒 |

## 关键不变量

`check_invariants()` 在每次状态转移后检查：

1. 根快照存活，所有非根存活快照的父快照存活，父链无环且有界。
2. 所有局部 `block` 槽位指向已分配块；`inherit`/`zero` 槽位不携带块号。
3. 每个块的 `refs` 等于所有存活快照局部块槽位对它的引用总数。
4. `allocated[b] == (refs[b] != 0)`，因此既无悬挂引用，也无“已分配但无人引用”的泄漏块。
5. 已删除快照不保留任何局部槽位。

## 验证

```bash
cmake -S . -B build -DCMAKE_BUILD_TYPE=Debug -DBUILD_TESTING=ON
cmake --build build -j
ctest --test-dir build --output-on-failure
```

测试包含：

- `dlks_formal_tests`：定向用例，覆盖快照隔离、多级 push-down、discard、父快照删除、共享块引用迁移、prepare 前/后崩溃、容量耗尽、陈旧事务拒绝。
- `dlks_formal_exhaustive`：`LBA=2, snapshots=3, blocks=4`，BFS 穷举全部 18,308 个可达状态。
- `dlks_formal_exhaustive_tree`：`LBA=1, snapshots=4, blocks=4`，重点覆盖“父快照带两个子快照并共享局部块”的删除转移，穷举 8,024 个可达状态。

穷举器把物理块号按首次出现规范化，合并同构状态。对每个状态枚举：

- 所有快照、LBA、两个数据值的覆盖写；
- 所有 discard 和快照创建/删除；
- 每个写事务的 `abort`、prepare 前 crash、prepare 后 crash + `recover`；
- discard/delete 的 prepare 前与 prepare 后崩溃路径。

每次转移后都用“创建时冻结全量读值”的参考模型逐快照、逐 LBA 对比读值，并执行 `check_invariants()` 验证引用守恒。程序还会断言至少实际覆盖了写、discard、删除、崩溃恢复以及双子女共享块转移场景。

## 约束

- 固定容量通过模板参数给出，适合嵌入到无动态分配的目标环境。
- 组件为单线程状态机；并发写需要外部串行化。
- `delete_snapshot` 不允许删除根快照。
- 内存中的 redo 记录代表持久化边界；实际设备可将 prepare 记录和提交后的状态映射到稳定存储。
