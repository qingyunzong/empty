# tilelib — 版本化视口瓦片缓存（C++20)

按视口层级请求瓦片的缓存库：旧视口迟到结果只入同版本缓存、不占新视口
必需容量；父瓦片可临时替代并标注缺失精度；可控加载器驱动验收、逐出与
取消；每块瓦片带来源证据，字节预算全程守恒。

## 设计

- `TileId{z,x,y}`：四叉树瓦片地址，`parent()` 向上一层。
- `TileCache::setViewport(required)`：推进视口代际（`version_`)。新视口
  必需瓦片被 pin（不可逐出）；不再需要的在途加载被取消；缺失的必需瓦片
  发起加载，已缓存/已在途的不重复请求。
- 迟到结果（`accept` 时 `version < version_` 或瓦片不在当前必需集）：
  以原版本号入缓存、不 pin；逐出只发生在未 pin 的 LRU 条目上，因此迟到
  结果只能使用当前必需容量之外的剩余空间，放不下则丢弃（`droppedCount`)。
- `resolve(id)`：精确命中返回 `exact=true`；否则向上找最近缓存祖先，
  返回 `exact=false` 且 `missing_levels` 标注缺失精度层数。
- `ManualLoader`：可控加载器。`complete()` 显式驱动完成；`cancel()` 为
  尽力取消——已取消的加载进入 zombie 态，仍可 `complete` 以模拟取消后
  迟到的网络结果。
- 来源证据：每次完成携带 `provenance` 字符串，随瓦片存储、再验收时更新。
- 字节预算守恒：不变式 `usedBytes() == summedBytes()` 且
  `usedBytes() <= budget()`，测试在每次操作后校验。

## 构建与测试

```sh
cmake -S . -B build
cmake --build build
ctest --test-dir build --output-on-failure
```

## 实际测试结果

环境：cmake 4.2.3,g++ 15.2.0(Ubuntu),Debug 构建，`-Wall -Wextra
-Wpedantic` 无告警。2026-10-05 实际运行输出：

```
1/6 Test #1: viewport_requests ................   Passed    0.01 sec
2/6 Test #2: late_result_old_version ..........   Passed    0.00 sec
3/6 Test #3: parent_substitute ................   Passed    0.00 sec
4/6 Test #4: eviction_budget_conservation .....   Passed    0.01 sec
5/6 Test #5: cancellation .....................   Passed    0.00 sec
6/6 Test #6: provenance .......................   Passed    0.00 sec

100% tests passed, 0 tests failed out of 6
```

## 用例覆盖

- `viewport_requests`：按视口层级发起缺失瓦片加载，缓存命中不重发。
- `late_result_old_version`：旧视口迟到结果带原版本入缓存；必需容量
  不足时丢弃而不挤占 pin 瓦片；有剩余空间时逐出未 pin 条目后入缓存。
- `parent_substitute`：缺失瓦片由祖先替代，`missing_levels` 标缺精度，
  精确瓦片到达后接管。
- `eviction_budget_conservation`:LRU 只逐出未 pin 条目；超预算瓦片被拒；
  每步校验 `usedBytes()==summedBytes()` 且不超过预算。
- `cancellation`：视口切换取消多余在途加载、不重发已在途请求；取消后
  迟到的 zombie 结果按旧版本规则入缓存。
- `provenance`：来源证据随瓦片保存并可通过 `resolve` 读取。
