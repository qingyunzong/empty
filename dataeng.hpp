#pragma once

#include <cstdint>
#include <vector>

namespace dataeng {

// 设备像素 RGBA 位图（行优先，每像素 4 字节）。
struct Image {
  int width = 0;
  int height = 0;
  std::vector<uint8_t> rgba;  // size == width * height * 4
};

// CSS 坐标系下的矩形（相对视口左上角）。
struct CssRect {
  double x = 0;
  double y = 0;
  double width = 0;
  double height = 0;
};

// 单次视口截图分块。
struct Tile {
  Image image;                       // 设备像素图
  double scrollY = 0;                // 截图时的 CSS 滚动位置
  std::vector<CssRect> fixedRects;   // fixed/sticky 区域（视口 CSS 坐标）
};

struct StitchParams {
  double deviceScaleFactor = 1.0;
  // CSS 滚动上限（maxScroll = 页面高 - 视口高）；< 0 表示不限制。
  double maxScrollY = -1.0;
  // 重叠区内容匹配的搜索半径（设备像素），用于吸收亚像素舍入误差。
  int matchSearchRadius = 4;
  // 平均灰度绝对差阈值（0-255），超过则判定无法一致对齐。
  double matchTolerance = 12.0;
};

// 输出画布上的缺口（设备像素行区间 [yStart, yEnd)）。
struct Gap {
  int yStart = 0;
  int yEnd = 0;
};

struct StitchResult {
  Image page;              // 拼接后的长图；第 0 行对应首块的有效滚动位置
  std::vector<Gap> gaps;   // 缺失或无法一致对齐验证的区域
  bool aligned = true;     // 所有分块均一致对齐时为 true
};

// 将按滚动位置排序前乱序给入的截图分块拼接为长页图。
// - scrollY 经 maxScrollY 钳制后按 deviceScaleFactor 换算并四舍五入到设备像素；
// - 相邻分块的重叠区做内容匹配，在 ±matchSearchRadius 内校正对齐；
// - 无法一致对齐时按标称位置放置并记录 Gap；
// - 首块之后的 fixed/sticky 掩码区域不再重复绘制（固定头只保留一次）。
StitchResult stitchTiles(const std::vector<Tile>& tiles,
                         const StitchParams& params);

}  // namespace dataeng
