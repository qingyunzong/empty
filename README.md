# PDF 文本几何归一

可嵌入 C++20 静态库，把 PDF text matrix、页面旋转、crop box 和字符 advance
转换为统一的页面坐标，并保留字形映射及内容流来源。

## 坐标约定

归一坐标原点位于旋转后可见 crop box 的左上角，x 向右、y 向下，尺寸随
`/Rotate` 交换。`PageGeometry::user_to_normalized()` 暴露完整仿射变换，
`denormalize()` 可回到 PDF 用户坐标。

## 公开接口

核心类型位于 `dataeng` 命名空间：

- `PageGeometry`：crop/media box、四向页面旋转及正反变换。
- `GlyphPlacement` / `normalize_glyph()`：由 PDF `Tm`、字号、缩放、rise、
  spacing 和千分之一 em 的 advance/glyph box 生成归一几何。
- `glyph_from_text_rendering_matrix()`：对已计算 `Trm` 的抽取器提供低层入口，
  字形框位于 `Trm` 的文本空间，advance 需已由 `Tm` 变换到 PDF 用户空间。
- `GlyphGeometry`：保留基线原点、advance 向量、字形四角、包围盒、文本方向轴、
  行列式/镜像标志、原始 `GlyphMapping` 和 `SourceRange`。
- `sort_by_geometry()`：仅根据归一后的包围盒和 advance/轴方向进行行/列分组和
  阅读顺序排序，不读取来源偏移或原内容流顺序；默认自动识别横排或竖排，
  也可显式指定 `HorizontalRows` / `VerticalColumns`。
- `build_text_intervals()`：按归一几何合并文本区间，每个区间带
  `first_glyph`、逐字形 `mappings`、逐字形 `sources` 与首尾 `SourceRange`。
- `GeometryNormalizer`：页面级便捷封装，一次完成归一、排序与区间构建。

`AdvanceUnits::ThousandthsOfEm` 表示传入的是 PDF 原始字形宽度（千分之一 em），
库会应用字号、横纵缩放及 spacing；`AdvanceUnits::TextSpace` 表示传入值已经
是文本空间位移。组合字形使用 `GlyphMapping::codepoints`、`cluster_id` 和
`composite` 完整保留；负缩放通过保留四角顺序、方向轴和行列式符号表达，
不会取绝对值而丢失镜像信息。竖排通过 `vertical` 标志和 advance 的 y 分量
参与行/列排序及区间切分。

## 使用示例

```cpp
#include "dataeng.hpp"

dataeng::PageGeometry page({18.0, 36.0, 594.0, 756.0},
                           dataeng::PageRotation::Clockwise90);

std::vector<dataeng::GlyphPlacement> placements = extract_glyphs();
dataeng::GeometryNormalizer normalizer(page);
std::vector<dataeng::GlyphGeometry> glyphs = normalizer.normalize(placements);
dataeng::sort_by_geometry(glyphs);
std::vector<dataeng::TextInterval> intervals =
    dataeng::build_text_intervals(glyphs);
```

`SourceRange::begin` 为包含起点，`SourceRange::end` 为排他终点；
`stream_offset` 是解码后内容流内的字节偏移，`glyph_index` 是显示字符串内的
字形序号。`TextInterval::source` 是同一内容流内的最小覆盖范围；跨内容流时
该字段为无效，以免给出错误的连续范围。每个区间始终保存逐字形 `sources`，
因此即使几何排序改变了顺序，也能逐个回溯原内容流位置。

## 构建与测试

```sh
cmake -S . -B build
cmake --build build
ctest --test-dir build --output-on-failure
```
