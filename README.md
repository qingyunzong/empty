# dlks_formal

`dlks_formal` 是一个可嵌入的 C++20 段式日志存储与段清理组件。它把记录追加写入固定容量的段，在清理时只搬迁索引仍指向的存活记录，并回收被覆盖记录、墓碑之外的脏段空间。组件为 header-only，无第三方依赖。

## 快速使用

```cpp
#include "dlks_formal.hpp"

dlks_formal::SegmentStore<int, int> store({/*segment_capacity=*/4096,
                                           /*segment_count=*/8});

store.put(1, 100, /*record_bytes=*/64);
store.put(1, 101, 64);       // 新版本；旧版本成为垃圾
store.erase(2, /*record_bytes=*/8);

if (store.begin_clean()) {   // 选一个脏段
  store.run_clean();         // 或反复调用 clean_step()
}

auto value = store.get(1);   // std::optional<int>
auto stats = store.stats();  // 容量 / 已用 / 空闲 / 存活 / 垃圾 / 已回收
```

`record_bytes` 是调用方给出的完整物理占用（记录头加负载），因此字节账目与 ABI、内存对齐无关。

## 语义

- 每次成功 `put`/`erase` 追加一条新记录并分配单调递增的 `version`。
- 索引只保存每个 key 的最新记录位置；旧版本和旧墓碑仍在物理段中，但属于垃圾。
- `erase` 写入墓碑。墓碑也参与搬迁，避免清理旧段后复活更早的值。
- 记录只能追加，段满后进入 `Sealed`；清理中的段进入 `Cleaning`，不再接受追加。
- `Free` 段没有记录、没有预留，可直接作为新活动段或搬迁目标。

## 清理流程

清理是显式状态机，而不是一次不可打断的大操作：

1. `begin_clean()` / `begin_clean(segment_id)` 选择受害者。
2. 若存在空闲段，受害者被搬迁到该段；否则在受害者内部原地压缩。
3. `clean_step()` 每次最多处理一个候选记录。复制前会在同一把锁内重新校验索引仍指向该槽位。
4. 最后一个候选处理完后释放受害者，受害者变为 `Free`。

### 搬迁模式

- **Relocate**：受害者为 `Sealed` 且存在 `Free` 段。目标段被标为 `Active` 并预留 `victim.live_bytes`。写线程只能使用未预留空间。复制完成后释放受害者，回收其全部未复制字节。
- **InPlace**：没有空闲段时使用。在锁内重建受害者记录数组，只保留索引仍引用的记录，随后把段重新标为 `Active`（除非再次写满），使回收出的尾部可继续追加。
- **全死受害者**：`live_bytes == 0` 时直接释放，不需要复制。

### 并发规则

- 所有公开操作由同一把 `std::mutex` 串行化，可从任意线程并发调用。
- 清理期间的新写入进入其他活动段，或进入搬迁目标段的未预留区域，不会被清理器删除。
- 若写入在清理器复制某条记录前更新了同一 key，复制前的索引复核会失败，该候选被跳过并释放预留。
- 若写入发生在复制之后，目标段中的旧副本自然成为垃圾；索引仍指向新版本，不会回退。

## 守恒关系

对整库和每个段维护以下不变量：

```text
capacity_i = used_i + free_i
used_i     = sum(record.bytes)
used       = live + dead
capacity   = used + free
free       = reserved + available
```

其中 `live` 包含仍被索引引用的值记录和墓碑，`dead` 是物理存在但不再被索引引用的字节。一次清理的回收量为：

```text
relocate: victim.used_before - copied_bytes
in_place: victim.used_before - victim.used_after
```

无并发写入交错时，清理满足：

```text
free_after - free_before == reclaimed_after - reclaimed_before
used_after == used_before - (reclaimed_after - reclaimed_before)
```

## 验证

测试目标是“小地址空间穷举 + 朴素模型重算”，而不是只抽查若干用例。

- `tests/model.hpp` 维护一个完全不知道段的 `NaiveModel`：每个 key 的最后一次成功操作就是规范。
- 每次状态检查都从物理段重算：每段记录字节和、段空闲量、全局 used/free、索引最新版本、live/dead、预留与可用空间。
- `tests/exhaustive_test.cpp` 对一个极小的段配置穷举所有可达操作序列（写入、删除、指定段清理、自动选段、单步清理、完整清理），并允许清理步骤插入任意写入之间。当前三组配置合计约 94 万个状态。
- `tests/scenario_test.cpp` 覆盖搬迁、原地压缩、容量耗尽、全死段、墓碑、预留空间写入、复制前后覆盖等边界。
- `tests/concurrency_test.cpp` 用真实线程并行写入并单步清理，最后逐一核对每个 key 的最新值。

## 构建与测试

```sh
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j
ctest --test-dir build --output-on-failure
```

Sanitizer：

```sh
cmake -S . -B build-asan -DCMAKE_BUILD_TYPE=Debug -DDLKS_SANITIZE=ON
cmake --build build-asan -j
ASAN_OPTIONS=detect_leaks=0 ./build-asan/dlks_tests
```

部分受限容器中 LeakSanitizer 无法在 ptrace 下运行，因此示例关闭了 leak 检测；ASan/UBSan 检查仍然生效。
