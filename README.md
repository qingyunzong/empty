# kway_merge

K 路有序归并库（C++20，头文件 only）。接收 K 个有序游标，输出按
`(key, source)` 排序的统一记录流。

## 设计

- `kway::Cursor<Key, Value>`：源游标接口。`next()` 推进（耗尽返回
  `false`，可抛异常报错），`key()/value()` 访问当前记录，
  `close()` 释放资源（要求幂等、不抛异常）。
- `kway::Merger<Key, Value>`：归并器。
  - 最小堆按 `(key, source)` 排序，键相同按源号升序。
  - **每源最多一条未消费记录**：仅在堆顶记录被消费后才从对应源
    再拉取一条（首次 `next()` 时惰性预取每源第一条）。
  - **暂停**：`pause()` 后 `next()` 返回 `Status::Paused`，不触碰
    任何源；`resume()` 恢复。
  - **源报错**：源的 `next()` 抛异常时，该源被关闭并移除，错误以
    `Status::SourceError`（含 `error_source` 与 `error`）上报，
    其余源继续归并。
  - **取消**：`cancel()` 幂等地关闭全部游标（每个恰好一次），之后
    `next()` 返回 `Status::Done`；析构自动调用 `cancel()`，绝不
    重复关闭。

## 用法

```cpp
#include <kway_merge/merger.hpp>

std::vector<std::unique_ptr<kway::Cursor<int, int>>> cursors = /* ... */;
kway::Merger<int, int> merger(std::move(cursors));

for (;;) {
    auto result = merger.next();
    switch (result.status) {
    case kway::Status::Ok:
        consume(*result.record);          // record: {key, source, value}
        break;
    case kway::Status::Paused:            // merger.pause() 生效中
        break;
    case kway::Status::SourceError:       // result.error_source / result.error
        break;
    case kway::Status::Done:
        return;
    }
}
```

## 构建与测试

```sh
cmake -S . -B build
cmake --build build
ctest --test-dir build --output-on-failure
```

测试（CTest，每文件一个可执行）：

- `test_merge`：全数组归并模型核验（拼接后按 `(key, source)` 排序
  作为参照），含重复键、空源与 300 轮随机模糊测试。
- `test_pause`：暂停期间不读任何源，恢复后流无缝衔接。
- `test_error`：受控读源在指定读次抛错；核验错误源号、异常传递、
  失败源恰好关闭一次、其余源继续归并。
- `test_cancel`：任意状态下取消均恰好关闭每个游标一次，重复取消
  与析构不重复关闭。
- `test_lookahead`：每个观测点上各源 `reads <= delivered + 1`，
  即每源最多缓存一条未消费记录（含暂停/报错交织与随机模糊）。

可选：`-DKWAY_ENABLE_SANITIZERS=ON` 启用 ASan/UBSan 构建测试。
