#include "dataeng.hpp"

#include <algorithm>
#include <cmath>
#include <limits>
#include <numeric>

namespace dataeng {
namespace {

struct DeviceRect {
  int x0, y0, x1, y1;
};

// CSS 矩形 -> 设备像素矩形（四舍五入并钳制到图内）。
DeviceRect toDeviceRect(const CssRect& r, double dsf, int w, int h) {
  DeviceRect d;
  d.x0 = static_cast<int>(std::llround(r.x * dsf));
  d.y0 = static_cast<int>(std::llround(r.y * dsf));
  d.x1 = static_cast<int>(std::llround((r.x + r.width) * dsf));
  d.y1 = static_cast<int>(std::llround((r.y + r.height) * dsf));
  d.x0 = std::clamp(d.x0, 0, w);
  d.y0 = std::clamp(d.y0, 0, h);
  d.x1 = std::clamp(d.x1, d.x0, w);
  d.y1 = std::clamp(d.y1, d.y0, h);
  return d;
}

// 每行是否被任一 fixed/sticky 掩码覆盖（用于匹配时剔除固定区域）。
std::vector<char> maskedRows(const Tile& tile, double dsf) {
  std::vector<char> mask(static_cast<size_t>(tile.image.height), 0);
  for (const CssRect& r : tile.fixedRects) {
    DeviceRect d = toDeviceRect(r, dsf, tile.image.width, tile.image.height);
    for (int y = d.y0; y < d.y1; ++y) mask[static_cast<size_t>(y)] = 1;
  }
  return mask;
}

uint8_t grayAt(const Image& img, int x, int y) {
  const uint8_t* p =
      &img.rgba[(static_cast<size_t>(y) * img.width + x) * 4];
  return static_cast<uint8_t>(
      (p[0] * 299 + p[1] * 587 + p[2] * 114) / 1000);
}

struct MatchResult {
  int shift = 0;
  double score = std::numeric_limits<double>::infinity();
};

// 在 ±radius 内搜索 next 相对 prev 的纵向校正量。
// 标称情况下 next 的第 r 行对应 prev 的第 r + delta 行；
// 候选校正 s 下对应 prev 的第 r + delta + s 行。
// 仅统计两侧都未被 fixed/sticky 掩码覆盖的行。
MatchResult matchOverlap(const Image& prev, const Image& next, int delta,
                         const std::vector<char>& prevMask,
                         const std::vector<char>& nextMask, int radius) {
  MatchResult best;
  const int width = std::min(prev.width, next.width);
  if (width <= 0) return best;
  const int xStride = std::max(1, width / 128);

  for (int s = -radius; s <= radius; ++s) {
    const int rLo = std::max(0, -delta - s);
    const int rHi = std::min(next.height, prev.height - delta - s);
    if (rHi - rLo < 4) continue;
    const int yStride = std::max(1, (rHi - rLo) / 64);

    double sum = 0;
    int64_t count = 0;
    for (int r = rLo; r < rHi; r += yStride) {
      if (nextMask[static_cast<size_t>(r)]) continue;
      const int rp = r + delta + s;
      if (prevMask[static_cast<size_t>(rp)]) continue;
      for (int x = 0; x < width; x += xStride) {
        sum += std::abs(static_cast<int>(grayAt(next, x, r)) -
                        static_cast<int>(grayAt(prev, x, rp)));
        ++count;
      }
    }
    if (count == 0) continue;
    const double score = sum / count;
    // 得分相近时优先 |s| 更小者，保证结果确定且贴近标称位置。
    if (score < best.score - 0.5 ||
        (score <= best.score + 0.5 && std::abs(s) < std::abs(best.shift))) {
      best.score = score;
      best.shift = s;
    }
  }
  return best;
}

}  // namespace

StitchResult stitchTiles(const std::vector<Tile>& tiles,
                         const StitchParams& params) {
  StitchResult result;
  if (tiles.empty()) return result;

  const double dsf =
      params.deviceScaleFactor > 0 ? params.deviceScaleFactor : 1.0;
  const int radius = std::max(0, params.matchSearchRadius);

  // 有效滚动位置：下限 0，上限 maxScrollY（滚动上限钳制）。
  auto effectiveScroll = [&](const Tile& t) {
    double s = std::max(0.0, t.scrollY);
    if (params.maxScrollY >= 0) s = std::min(s, params.maxScrollY);
    return s;
  };

  std::vector<size_t> order(tiles.size());
  std::iota(order.begin(), order.end(), 0);
  std::stable_sort(order.begin(), order.end(), [&](size_t a, size_t b) {
    return effectiveScroll(tiles[a]) < effectiveScroll(tiles[b]);
  });

  const size_t n = order.size();
  std::vector<const Tile*> sorted(n);
  // 亚像素舍入：每块的设备滚动量独立四舍五入，增量取差值，避免误差累积。
  std::vector<int64_t> scrollDev(n);
  std::vector<std::vector<char>> rowMasks(n);
  int canvasWidth = 0;
  for (size_t i = 0; i < n; ++i) {
    sorted[i] = &tiles[order[i]];
    scrollDev[i] =
        static_cast<int64_t>(std::llround(effectiveScroll(*sorted[i]) * dsf));
    rowMasks[i] = maskedRows(*sorted[i], dsf);
    canvasWidth = std::max(canvasWidth, sorted[i]->image.width);
  }

  // 第一遍：确定每块在画布上的纵向位置。
  std::vector<int64_t> placeY(n, 0);
  for (size_t i = 1; i < n; ++i) {
    const Image& prevImg = sorted[i - 1]->image;
    const Image& nextImg = sorted[i]->image;
    int64_t delta = scrollDev[i] - scrollDev[i - 1];
    const int64_t nominal = placeY[i - 1] + delta;
    const int64_t prevBottom = placeY[i - 1] + prevImg.height;

    if (delta >= prevImg.height || prevImg.height == 0 ||
        nextImg.height == 0) {
      // 无重叠：无法匹配验证；若有空洞则记录缺口。
      placeY[i] = nominal;
      if (nominal > prevBottom) {
        result.gaps.push_back(
            {static_cast<int>(prevBottom), static_cast<int>(nominal)});
        result.aligned = false;
      }
      continue;
    }

    MatchResult m =
        matchOverlap(prevImg, nextImg, static_cast<int>(delta), rowMasks[i - 1],
                     rowMasks[i], radius);
    if (m.score <= params.matchTolerance) {
      placeY[i] = nominal + m.shift;
      if (placeY[i] > prevBottom) {
        // 校正后仍出现空洞。
        result.gaps.push_back({static_cast<int>(prevBottom),
                               static_cast<int>(placeY[i])});
        result.aligned = false;
      }
    } else {
      // 无法一致对齐：按标称位置放置，并把无法验证的重叠带记为缺口。
      placeY[i] = nominal;
      const int64_t seamLo = std::min(nominal, prevBottom);
      const int64_t seamHi = std::max(nominal, prevBottom);
      result.gaps.push_back(
          {static_cast<int>(seamLo), static_cast<int>(seamHi)});
      result.aligned = false;
    }
  }

  // 画布高度：末块底边；画布第 0 行对应 scrollDev[0]。
  int64_t canvasHeight = 0;
  for (size_t i = 0; i < n; ++i)
    canvasHeight =
        std::max(canvasHeight, placeY[i] + sorted[i]->image.height);
  if (canvasWidth <= 0 || canvasHeight <= 0) return result;

  result.page.width = canvasWidth;
  result.page.height = static_cast<int>(canvasHeight);
  result.page.rgba.assign(
      static_cast<size_t>(canvasWidth) * static_cast<size_t>(canvasHeight) * 4,
      0);

  // 第二遍：绘制。首块之后的 fixed/sticky 掩码区域跳过，避免固定头重复。
  for (size_t i = 0; i < n; ++i) {
    const Tile& tile = *sorted[i];
    const Image& img = tile.image;
    std::vector<DeviceRect> fixed;
    if (i > 0) {
      for (const CssRect& r : tile.fixedRects)
        fixed.push_back(toDeviceRect(r, dsf, img.width, img.height));
    }
    for (int y = 0; y < img.height; ++y) {
      const int64_t dy = placeY[i] + y;
      if (dy < 0 || dy >= canvasHeight) continue;
      uint8_t* dst =
          &result.page.rgba[static_cast<size_t>(dy) * canvasWidth * 4];
      const uint8_t* src =
          &img.rgba[static_cast<size_t>(y) * img.width * 4];
      if (fixed.empty()) {
        std::copy_n(src, static_cast<size_t>(img.width) * 4, dst);
        continue;
      }
      for (int x = 0; x < img.width; ++x) {
        bool masked = false;
        for (const DeviceRect& d : fixed) {
          if (y >= d.y0 && y < d.y1 && x >= d.x0 && x < d.x1) {
            masked = true;
            break;
          }
        }
        if (masked) continue;
        std::copy_n(src + static_cast<size_t>(x) * 4, 4,
                    dst + static_cast<size_t>(x) * 4);
      }
    }
  }

  return result;
}

}  // namespace dataeng
