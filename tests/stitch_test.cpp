#include <cassert>
#include <cmath>
#include <cstdio>
#include <vector>

#include "dataeng.hpp"

namespace {

using dataeng::CssRect;
using dataeng::Image;
using dataeng::StitchParams;
using dataeng::StitchResult;
using dataeng::Tile;

// 确定性伪随机，保证可复现。
uint32_t hashPixel(int x, int y) {
  uint32_t h = static_cast<uint32_t>(x) * 2654435761u ^
               static_cast<uint32_t>(y) * 40503u;
  h ^= h >> 13;
  h *= 0x5bd1e995u;
  h ^= h >> 15;
  return h;
}

struct Sim {
  double dsf = 2.0;
  int pageW = 400;    // 设备像素
  int pageH = 2400;   // 设备像素（CSS 高 1200）
  int viewH = 300;    // 视口设备像素（CSS 高 150）
  int headerH = 80;   // 固定头设备像素（CSS 高 40）
  double maxScrollCss = 1050.0;  // 1200 - 150
  Image page;

  Sim() {
    page.width = pageW;
    page.height = pageH;
    page.rgba.resize(static_cast<size_t>(pageW) * pageH * 4);
    for (int y = 0; y < pageH; ++y)
      for (int x = 0; x < pageW; ++x) {
        uint32_t h = hashPixel(x, y);
        uint8_t* p = &page.rgba[(static_cast<size_t>(y) * pageW + x) * 4];
        p[0] = static_cast<uint8_t>(h & 0xff);
        p[1] = static_cast<uint8_t>((h >> 8) & 0xff);
        p[2] = static_cast<uint8_t>((h >> 16) & 0xff);
        p[3] = 255;
      }
  }

  uint8_t headerPixel(int x, int y, int c) const {
    // 固定头内容只与视口内位置有关，与滚动无关。
    return static_cast<uint8_t>((x * 7 + y * 3 + c * 40) % 251);
  }

  // 模拟一次视口截图：浏览器先将滚动钳制到上限，CSS 滚动位置 ->
  // 设备偏移四舍五入，顶部叠加固定头。
  Tile capture(double scrollCss) const {
    Tile t;
    t.scrollY = std::min(scrollCss, maxScrollCss);
    t.fixedRects.push_back(CssRect{0, 0, 200, 40});
    const int off =
        static_cast<int>(std::llround(t.scrollY * dsf));  // 渲染端舍入
    t.image.width = pageW;
    t.image.height = viewH;
    t.image.rgba.resize(static_cast<size_t>(pageW) * viewH * 4);
    for (int y = 0; y < viewH; ++y)
      for (int x = 0; x < pageW; ++x) {
        uint8_t* p =
            &t.image.rgba[(static_cast<size_t>(y) * pageW + x) * 4];
        if (y < headerH) {
          p[0] = headerPixel(x, y, 0);
          p[1] = headerPixel(x, y, 1);
          p[2] = headerPixel(x, y, 2);
        } else {
          const uint8_t* s = &page.rgba[(
              static_cast<size_t>(off + y) * pageW + x) * 4];
          p[0] = s[0];
          p[1] = s[1];
          p[2] = s[2];
        }
        p[3] = 255;
      }
    return t;
  }
};

bool pixelEq(const Image& img, int x, int y, uint8_t r, uint8_t g, uint8_t b) {
  const uint8_t* p =
      &img.rgba[(static_cast<size_t>(y) * img.width + x) * 4];
  return p[0] == r && p[1] == g && p[2] == b;
}

int failures = 0;
#define CHECK(cond)                                              \
  do {                                                           \
    if (!(cond)) {                                               \
      std::printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); \
      ++failures;                                                \
    }                                                            \
  } while (0)

// 主流程：亚像素滚动 + 滚动上限钳制 + 固定头去重。
void testStitchBasic() {
  Sim sim;
  std::vector<Tile> tiles;
  // CSS 滚动：含 .5 亚像素；最后一块超出上限 1050，应被钳制。
  for (double s : {0.0, 100.5, 201.0, 302.5, 403.0, 503.5, 604.0, 704.5,
                   805.0, 905.5, 1006.0, 1200.0})
    tiles.push_back(sim.capture(s));

  StitchParams params;
  params.deviceScaleFactor = sim.dsf;
  params.maxScrollY = 1050.0;  // 1200 - 150
  StitchResult res = dataeng::stitchTiles(tiles, params);

  CHECK(res.aligned);
  CHECK(res.gaps.empty());
  CHECK(res.page.width == sim.pageW);
  CHECK(res.page.height == sim.pageH);  // 0 .. 2100+300

  // 页面内容区与参考一致。
  bool contentOk = true;
  for (int y = sim.headerH; y < sim.pageH && contentOk; y += 7)
    for (int x = 0; x < sim.pageW; x += 13) {
      const uint8_t* ref =
          &sim.page.rgba[(static_cast<size_t>(y) * sim.pageW + x) * 4];
      if (!pixelEq(res.page, x, y, ref[0], ref[1], ref[2])) {
        contentOk = false;
        break;
      }
    }
  CHECK(contentOk);

  // 固定头只出现一次（顶部 80 行），其下方是页面内容而非头图案。
  bool headerOk = true;
  for (int y = 0; y < sim.headerH; y += 3)
    for (int x = 0; x < sim.pageW; x += 11)
      if (!pixelEq(res.page, x, y, sim.headerPixel(x, y, 0),
                   sim.headerPixel(x, y, 1), sim.headerPixel(x, y, 2)))
        headerOk = false;
  CHECK(headerOk);
  // 后续分块的固定头位置（如设备行 201..281）应保留页面内容。
  bool noDupHeader = true;
  for (int y = 201; y < 281; y += 5)
    for (int x = 0; x < sim.pageW; x += 17) {
      const uint8_t* ref =
          &sim.page.rgba[(static_cast<size_t>(y) * sim.pageW + x) * 4];
      if (!pixelEq(res.page, x, y, ref[0], ref[1], ref[2]))
        noDupHeader = false;
    }
  CHECK(noDupHeader);
}

// 分块乱序输入也应正确拼接。
void testUnorderedInput() {
  Sim sim;
  std::vector<Tile> tiles;
  tiles.push_back(sim.capture(201.0));
  tiles.push_back(sim.capture(0.0));
  tiles.push_back(sim.capture(100.5));
  StitchParams params;
  params.deviceScaleFactor = sim.dsf;
  StitchResult res = dataeng::stitchTiles(tiles, params);
  CHECK(res.aligned);
  CHECK(res.gaps.empty());
  CHECK(res.page.height == 402 + 300);
}

// 滚动位置空洞 -> 返回缺口。
void testScrollHole() {
  Sim sim;
  std::vector<Tile> tiles;
  tiles.push_back(sim.capture(0.0));
  tiles.push_back(sim.capture(400.0));  // 800 设备px，超过视口高 300
  StitchParams params;
  params.deviceScaleFactor = sim.dsf;
  StitchResult res = dataeng::stitchTiles(tiles, params);
  CHECK(!res.aligned);
  CHECK(res.gaps.size() == 1);
  CHECK(res.gaps[0].yStart == 300);
  CHECK(res.gaps[0].yEnd == 800);
}

// 内容损坏的分块无法一致对齐 -> 返回缺口，不错误合并。
void testCorruptTile() {
  Sim sim;
  std::vector<Tile> tiles;
  tiles.push_back(sim.capture(0.0));
  Tile bad = sim.capture(100.0);
  for (size_t i = 0; i < bad.image.rgba.size(); i += 4) {
    bad.image.rgba[i] = static_cast<uint8_t>(i % 251);
    bad.image.rgba[i + 1] = static_cast<uint8_t>((i * 3) % 241);
    bad.image.rgba[i + 2] = static_cast<uint8_t>((i * 7) % 239);
  }
  tiles.push_back(bad);
  tiles.push_back(sim.capture(200.0));
  StitchParams params;
  params.deviceScaleFactor = sim.dsf;
  StitchResult res = dataeng::stitchTiles(tiles, params);
  CHECK(!res.aligned);
  CHECK(!res.gaps.empty());
}

// 重复滚动位置（钳制到上限后 delta 为 0）不应产生缺口或错位。
void testDuplicateScroll() {
  Sim sim;
  std::vector<Tile> tiles;
  tiles.push_back(sim.capture(900.0));
  tiles.push_back(sim.capture(1100.0));  // 钳制到 1050
  tiles.push_back(sim.capture(1200.0));  // 钳制到 1050
  StitchParams params;
  params.deviceScaleFactor = sim.dsf;
  params.maxScrollY = 1050.0;
  StitchResult res = dataeng::stitchTiles(tiles, params);
  CHECK(res.aligned);
  CHECK(res.gaps.empty());
  // 画布第 0 行对应首块滚动位置 1800，末块钳制到 2100。
  CHECK(res.page.height == 2100 + 300 - 1800);
}

}  // namespace

int main() {
  testStitchBasic();
  testUnorderedInput();
  testScrollHole();
  testCorruptTile();
  testDuplicateScroll();
  if (failures == 0) {
    std::printf("all stitch tests passed\n");
    return 0;
  }
  std::printf("%d check(s) failed\n", failures);
  return 1;
}
