字体渲染器需要C++轮廓组件，输入闭合轮廓中的点及on-curve标志，按TrueType约定在相邻off-curve点间补隐式中点，首尾均为off-curve时也适用。先应用调用方仿射变换，再以设备空间误差上限自适应细分二次曲线，输出供填充器调用的有向线段。达到细分深度上限仍超差须明确失败，不交付半个字形。测试纯off-curve轮廓、镜像变换、极扁曲线及循环移位输入几何一致。

## 组件

`include/font/contour.hpp`（header-only，C++20）提供
`font::flattenContour`，把一条闭合 TrueType 轮廓展平为设备空间的有向线段：

1. 先对全部输入点应用调用方仿射变换 `font::Affine`。
2. 在相邻 off-curve 点之间插入隐式 on-curve 中点；首尾均为 off-curve
   时，环绕边界同样插入。
3. 对每条二次曲线按设备空间偏差自适应二分细分，直到控制点到弦的
   距离不超过 `tolerance`。
4. 达到 `maxDepth` 仍超差时返回 `FlattenError::kDepthLimitExceeded`，
   并清空输出，调用方不会拿到半个字形。

输出为 `font::Segment{from, to}` 闭合有向环，方向随轮廓（及负行列式
变换）保持/翻转，可直接交给填充器。

## 构建与测试

```sh
cmake -S . -B build
cmake --build build
ctest --test-dir build --output-on-failure
```

测试覆盖：纯 off-curve 轮廓（含首尾环绕隐式中点）、镜像与一般仿射
变换、极扁/共线曲线与压扁轮廓、循环移位几何一致、深度上限失败不产生
部分输出，以及稠密采样下的设备空间误差上限数值验证。
