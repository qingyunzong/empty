# 截图分块拼接几何

页面存档管线要可嵌入 C++ 长页截图拼接组件，输入每块设备像素图、CSS 滚动位置、deviceScaleFactor 和 fixed/sticky 区域掩码。处理亚像素舍入和滚动上限，重叠区按内容匹配校正；无法一致对齐时返回缺口，不重复固定头。

## 用法

```cpp
#include "dataeng.hpp"

dataeng::StitchParams params;
params.deviceScaleFactor = 2.0;
params.maxScrollY = 1050.0;  // CSS 滚动上限，<0 表示不限制

std::vector<dataeng::Tile> tiles = ...;  // 每块：设备像素图 + CSS scrollY + fixed/sticky 掩码
dataeng::StitchResult res = dataeng::stitchTiles(tiles, params);
// res.page 为拼接长图；res.gaps 为缺失/无法一致对齐的区域；res.aligned 表示整体是否一致对齐
```

行为要点：

- `scrollY` 先经 `maxScrollY` 钳制，再乘 `deviceScaleFactor` 四舍五入到设备像素；各块独立舍入、增量取差，避免误差累积。
- 相邻块重叠区在 ±`matchSearchRadius`（设备像素）内做灰度内容匹配校正，掩码覆盖行不参与匹配。
- 匹配得分超过 `matchTolerance` 时按标称位置放置，并把无法验证的重叠带记入 `gaps`。
- 首块之后的 fixed/sticky 掩码区域不再绘制，固定头在结果中只保留一次。

## 构建与测试

```sh
cmake -S . -B build && cmake --build build
cd build && ctest --output-on-failure
```
