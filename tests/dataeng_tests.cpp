#include "dataeng.hpp"

#include <cmath>
#include <cstdlib>
#include <iostream>
#include <string>
#include <tuple>
#include <vector>

namespace {

void require(bool condition, const std::string& message) {
    if (!condition) {
        std::cerr << "FAILED: " << message << '\n';
        std::exit(1);
    }
}

bool near(double lhs, double rhs, double tolerance = 1e-9) {
    return std::abs(lhs - rhs) <= tolerance;
}

bool near_point(dataeng::Point lhs, dataeng::Point rhs, double tolerance = 1e-9) {
    return near(lhs.x, rhs.x, tolerance) && near(lhs.y, rhs.y, tolerance);
}

dataeng::SourceRange source_at(std::uint64_t offset, std::uint64_t glyph_index = 0) {
    dataeng::SourceRange source;
    source.begin.stream_offset = offset;
    source.begin.glyph_index = glyph_index;
    source.end.stream_offset = offset + 1;
    source.end.glyph_index = glyph_index + 1;
    source.valid = true;
    return source;
}

dataeng::GlyphPlacement placement_at(
    double x,
    double y,
    std::string text,
    std::uint64_t source_offset,
    std::uint32_t glyph_id = 1) {
    dataeng::GlyphPlacement placement;
    placement.text_matrix = dataeng::translation(x, y);
    placement.font_size = 10.0;
    placement.advance = {500.0, 0.0};
    placement.glyph_box = {0.0, -200.0, 1000.0, 800.0};
    placement.mapping.glyph_id = glyph_id;
    placement.mapping.text = std::move(text);
    placement.source = source_at(source_offset);
    return placement;
}

void test_page_rotation_and_crop() {
    const dataeng::Rect crop{10.0, 20.0, 110.0, 220.0};
    for (const int rotation : {0, 90, 180, 270}) {
        dataeng::PageGeometry page(crop, rotation);
        const dataeng::Point lower_left = page.normalize(dataeng::Point{10.0, 20.0});
        const dataeng::Point upper_right = page.normalize(dataeng::Point{110.0, 220.0});
        switch (rotation) {
            case 0:
                require(near_point(lower_left, {0.0, 200.0}), "rot0 lower left");
                require(near_point(upper_right, {100.0, 0.0}), "rot0 upper right");
                break;
            case 90:
                require(near_point(lower_left, {0.0, 0.0}), "rot90 lower left");
                require(near_point(upper_right, {200.0, 100.0}), "rot90 upper right");
                break;
            case 180:
                require(near_point(lower_left, {100.0, 0.0}), "rot180 lower left");
                require(near_point(upper_right, {0.0, 200.0}), "rot180 upper right");
                break;
            case 270:
                require(near_point(lower_left, {200.0, 100.0}), "rot270 lower left");
                require(near_point(upper_right, {0.0, 0.0}), "rot270 upper right");
                break;
            default:
                require(false, "unexpected rotation");
        }
        require(near(page.width(),
                     rotation == 90 || rotation == 270 ? 200.0 : 100.0),
                "normalized width");
        require(near(page.height(),
                     rotation == 90 || rotation == 270 ? 100.0 : 200.0),
                "normalized height");
        require(near_point(page.denormalize(page.normalize(dataeng::Point{60.0, 120.0})),
                           {60.0, 120.0}),
                "page transform round trip");
    }
}

void test_horizontal_glyph() {
    dataeng::PageGeometry page({0.0, 0.0, 200.0, 100.0}, 0);
    dataeng::GlyphPlacement placement;
    placement.text_matrix = dataeng::translation(50.0, 20.0);
    placement.font_size = 10.0;
    placement.advance = {500.0, 0.0};
    placement.mapping.glyph_id = 7;
    placement.mapping.codepoints = {65};
    placement.mapping.text = "A";
    placement.source = source_at(40);

    const dataeng::GlyphGeometry glyph = dataeng::normalize_glyph(placement, page);
    require(near_point(glyph.origin, {50.0, 80.0}), "glyph origin");
    require(near_point(glyph.advance, {5.0, 0.0}), "glyph advance");
    require(near(glyph.bounds.x0, 50.0), "glyph bounds left");
    require(near(glyph.bounds.x1, 60.0), "glyph bounds right");
    require(near(glyph.bounds.y0, 72.0), "glyph bounds top");
    require(near(glyph.bounds.y1, 82.0), "glyph bounds bottom");
    require(glyph.mapping.glyph_id == 7 && glyph.mapping.text == "A",
            "glyph mapping");
    require(glyph.source.valid && glyph.source.begin.stream_offset == 40,
            "source preserved");
}

void test_negative_scaling_preserves_geometry_and_mapping() {
    dataeng::PageGeometry page({0.0, 0.0, 200.0, 100.0}, 0);
    dataeng::GlyphPlacement placement;
    placement.text_matrix = {-10.0, 0.0, 0.0, 10.0, 100.0, 50.0};
    placement.advance = {1.0, 0.0};
    placement.advance_units = dataeng::AdvanceUnits::TextSpace;
    placement.glyph_box = {0.0, -1.0, 1.0, 1.0};
    placement.mapping.glyph_id = 99;
    placement.mapping.cluster_id = 12;
    placement.mapping.codepoints = {102, 105};
    placement.mapping.text = "fi";
    placement.mapping.composite = true;
    placement.source = source_at(3);

    const dataeng::GlyphGeometry glyph = dataeng::normalize_glyph(placement, page);
    require(glyph.mirrored && near(glyph.determinant, -100.0), "negative determinant");
    require(near_point(glyph.advance, {-10.0, 0.0}), "negative advance preserved");
    require(near(glyph.bounds.x0, 90.0) && near(glyph.bounds.x1, 100.0),
            "negative x bounds");
    require(near(glyph.bounds.y0, 40.0) && near(glyph.bounds.y1, 60.0),
            "negative y bounds");
    require(glyph.quad[0].x > glyph.quad[1].x, "quad winding preserves reflection");
    require(glyph.mapping.composite && glyph.mapping.codepoints.size() == 2,
            "composite mapping preserved");
    require(glyph.mapping.text == "fi" && glyph.mapping.cluster_id == 12,
            "cluster mapping preserved");
}

void test_rotated_page_advance() {
    dataeng::PageGeometry page({0.0, 0.0, 200.0, 100.0},
                               dataeng::PageRotation::Clockwise90);
    dataeng::GlyphPlacement placement;
    placement.text_matrix = dataeng::translation(50.0, 20.0);
    placement.font_size = 10.0;
    placement.advance = {500.0, 0.0};
    placement.mapping.text = "R";
    placement.source = source_at(77);

    const dataeng::GlyphGeometry glyph = dataeng::normalize_glyph(placement, page);
    require(near_point(glyph.origin, {20.0, 50.0}), "rotated glyph origin");
    require(near_point(glyph.advance, {0.0, 5.0}), "rotated glyph advance");
    require(near_point(glyph.x_axis, {0.0, 1.0}), "rotated glyph x axis");
    require(near(glyph.bounds.x0, 18.0) && near(glyph.bounds.x1, 28.0),
            "rotated glyph x bounds");
    require(near(glyph.bounds.y0, 50.0) && near(glyph.bounds.y1, 60.0),
            "rotated glyph y bounds");
}

void test_vertical_advance() {
    dataeng::PageGeometry page({0.0, 0.0, 100.0, 200.0}, 0);
    dataeng::GlyphPlacement placement;
    placement.text_matrix = dataeng::translation(20.0, 180.0);
    placement.font_size = 10.0;
    placement.advance = {0.0, -1000.0};
    placement.vertical = true;
    placement.mapping.glyph_id = 2;
    placement.mapping.codepoints = {0x6f22};
    placement.source = source_at(9);

    const dataeng::GlyphGeometry glyph = dataeng::normalize_glyph(placement, page);
    require(glyph.vertical, "vertical flag");
    require(near_point(glyph.advance, {0.0, 10.0}), "vertical advance");
    require(near(glyph.bounds.width(), 10.0), "vertical glyph width");
    require(near(glyph.bounds.height(), 10.0), "vertical glyph height");
}

void test_geometry_sort_ignores_source_order() {
    dataeng::PageGeometry page({0.0, 0.0, 100.0, 100.0}, 0);
    std::vector<dataeng::GlyphPlacement> placements{
        placement_at(10.0, 60.0, "B", 200),
        placement_at(10.0, 90.0, "A", 100),
        placement_at(30.0, 90.0, "C", 150),
    };
    std::vector<dataeng::GlyphGeometry> glyphs = dataeng::normalize_glyphs(placements, page);
    dataeng::sort_by_geometry(glyphs);
    require(glyphs[0].mapping.text == "A", "top row first glyph");
    require(glyphs[1].mapping.text == "C", "top row second glyph");
    require(glyphs[2].mapping.text == "B", "bottom row glyph");
}

void test_vertical_sort_uses_geometry() {
    dataeng::PageGeometry page({0.0, 0.0, 100.0, 200.0}, 0);
    std::vector<dataeng::GlyphPlacement> placements;
    for (const auto& [text, y, offset] :
         std::vector<std::tuple<std::string, double, std::uint64_t>>{
             {"C", 140.0, 300},
             {"A", 180.0, 100},
             {"B", 160.0, 200},
         }) {
        dataeng::GlyphPlacement placement;
        placement.text_matrix = dataeng::translation(20.0, y);
        placement.font_size = 10.0;
        placement.advance = {0.0, -1000.0};
        placement.vertical = true;
        placement.mapping.text = text;
        placement.source = source_at(offset);
        placements.push_back(std::move(placement));
    }

    std::vector<dataeng::GlyphGeometry> glyphs = dataeng::normalize_glyphs(placements, page);
    dataeng::sort_by_geometry(glyphs);
    require(glyphs[0].mapping.text == "A", "vertical top glyph first");
    require(glyphs[1].mapping.text == "B", "vertical middle glyph second");
    require(glyphs[2].mapping.text == "C", "vertical bottom glyph third");

    const auto intervals = dataeng::build_text_intervals(glyphs);
    require(intervals.size() == 1 && intervals[0].text == "ABC",
            "vertical text interval");
}

void test_text_interval_source_lookup() {
    dataeng::PageGeometry page({0.0, 0.0, 100.0, 100.0}, 0);
    std::vector<dataeng::GlyphPlacement> placements{
        placement_at(10.0, 90.0, "A", 100, 11),
        placement_at(18.0, 90.0, "B", 110, 12),
    };
    const dataeng::GeometryNormalizer normalizer(page);
    const auto intervals = normalizer.normalize_and_sort(placements);
    require(intervals.size() == 1, "single text interval");
    require(intervals[0].text == "AB", "interval text");
    require(intervals[0].source.valid, "interval source valid");
    require(intervals[0].source.begin.stream_offset == 100, "interval source begin");
    require(intervals[0].source.end.stream_offset == 111, "interval source end");
    require(intervals[0].mappings.size() == 2, "glyph mappings retained");
    require(intervals[0].mappings[0].glyph_id == 11
                && intervals[0].mappings[1].glyph_id == 12,
            "glyph ids retained");
}

}  // namespace

int main() {
    test_page_rotation_and_crop();
    test_horizontal_glyph();
    test_negative_scaling_preserves_geometry_and_mapping();
    test_rotated_page_advance();
    test_vertical_advance();
    test_geometry_sort_ignores_source_order();
    test_vertical_sort_uses_geometry();
    test_text_interval_source_lookup();
    std::cout << "all dataeng tests passed\n";
    return 0;
}
