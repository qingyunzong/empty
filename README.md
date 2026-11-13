# 双时态事实修正

审计数据仓库需要可嵌入 C++ bitemporal 状态库，同时维护 valid time 与 system time。回溯更正关闭当前系统版本并新增不覆盖历史的记录；删除作为有效时间区间的墓碑。任意 as-of/as-at 查询须返回唯一集合，区间边界统一为半开。

## 用法

```cpp
#include "dataeng.hpp"

dataeng::bitemporal_store<std::string, int> store;

store.put("k", 1, 10, 20, /*sys_now=*/100);   // 写入 [10,20)
store.put("k", 2, 15, 25, /*sys_now=*/200);   // 回溯更正：旧版本在 sys=200 关闭
store.erase("k", 18, 22, /*sys_now=*/300);    // 删除：写入墓碑记录

store.as_of("k", 16, 200);   // optional{2}：sys=200 时有效于 valid=16 的值
store.as_of("k", 16, 100);   // optional{1}：历史视图不被覆盖
store.snapshot(16, 200);     // map<key, value>：该时点全部存活键值
store.as_at(200);            // sys=200 时可见的全部记录（默认不含墓碑）
store.history("k");          // 该 key 的完整审计轨迹
```

## 语义

- 所有区间均为半开 `[from, to)`，valid 与 system 两个维度一致。
- 记录只增不改：更正把与目标有效区间重叠的当前系统版本关闭（`sys_to = now`），
  不重叠的残余段以新系统版本重新插入，再追加新记录。
- 删除是有效时间区间上的墓碑记录（`value == nullopt`），同样不抹除历史。
- 不变式：任意 `(valid_at, sys_at)` 点上每个 key 至多一条可见记录，
  因此 `as_of` / `snapshot` 恒返回唯一集合。
- 事务时间（system time）由调用方传入，应在多次变更间单调不减。

## 构建与测试

```sh
cmake -S . -B build && cmake --build build
ctest --test-dir build --output-on-failure
```
