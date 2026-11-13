#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <span>
#include <stdexcept>
#include <string>
#include <vector>

namespace dataeng {

struct Point {
    double x = 0.0;
    double y = 0.0;

    friend bool operator==(const Point&, const Point&) = default;
};

struct Rect {
    double x0 = 0.0;
    double y0 = 0.0;
    double x1 = 0.0;
    double y1 = 0.0;

    [[nodiscard]] double width() const noexcept { return x1 - x0; }
    [[nodiscard]] double height() const noexcept { return y1 - y0; }
    [[nodiscard]] Point center() const noexcept {
        return {(x0 + x1) * 0.5, (y0 + y1) * 0.5};
    }
    [[nodiscard]] bool empty() const noexcept { return x0 >= x1 || y0 >= y1; }

    friend bool operator==(const Rect&, const Rect&) = default;
};

[[nodiscard]] Rect normalized_rect(const Rect& rect) noexcept;
[[nodiscard]] Rect unite(const Rect& lhs, const Rect& rhs) noexcept;

struct Matrix {
    double a = 1.0;
    double b = 0.0;
    double c = 0.0;
    double d = 1.0;
    double e = 0.0;
    double f = 0.0;

    [[nodiscard]] Point apply(Point point) const noexcept;
    [[nodiscard]] Point apply_vector(Point vector) const noexcept;
    [[nodiscard]] Rect apply(const Rect& rect) const noexcept;
    [[nodiscard]] double determinant() const noexcept { return a * d - b * c; }
    [[nodiscard]] bool is_invertible() const noexcept;
    [[nodiscard]] Matrix inverse() const;

    friend bool operator==(const Matrix&, const Matrix&) = default;
};

[[nodiscard]] Matrix translation(double tx, double ty) noexcept;
[[nodiscard]] Matrix scaling(double sx, double sy) noexcept;
[[nodiscard]] Matrix concatenate(const Matrix& first, const Matrix& second) noexcept;

enum class PageRotation : int {
    None = 0,
    Clockwise90 = 90,
    Clockwise180 = 180,
    Clockwise270 = 270,
};

class PageGeometry {
public:
    PageGeometry();
    explicit PageGeometry(Rect crop_box, int rotate = 0);
    PageGeometry(Rect media_box, std::optional<Rect> crop_box, int rotate);
    PageGeometry(Rect crop_box, PageRotation rotate);
    PageGeometry(Rect media_box, std::optional<Rect> crop_box, PageRotation rotate);

    [[nodiscard]] const Rect& crop_box() const noexcept { return crop_box_; }
    [[nodiscard]] const Rect& media_box() const noexcept { return media_box_; }
    [[nodiscard]] int rotation() const noexcept { return rotation_; }
    [[nodiscard]] double width() const noexcept;
    [[nodiscard]] double height() const noexcept;

    [[nodiscard]] Point normalize(Point point) const noexcept;
    [[nodiscard]] Rect normalize(const Rect& rect) const noexcept;
    [[nodiscard]] Point denormalize(Point point) const noexcept;
    [[nodiscard]] Rect denormalize(const Rect& rect) const noexcept;

    [[nodiscard]] Matrix user_to_normalized() const noexcept;
    [[nodiscard]] Matrix normalized_to_user() const;

private:
    Rect media_box_{};
    Rect crop_box_{};
    int rotation_ = 0;
};

enum class AdvanceUnits {
    ThousandthsOfEm,
    TextSpace,
};

struct GlyphMapping {
    std::uint32_t glyph_id = 0;
    std::uint32_t cluster_id = 0;
    std::vector<std::uint32_t> codepoints;
    std::string text;
    bool composite = false;

    friend bool operator==(const GlyphMapping&, const GlyphMapping&) = default;
};

struct ContentLocation {
    std::uint32_t page_index = 0;
    std::uint32_t stream_index = 0;
    std::uint64_t stream_offset = 0;
    std::uint64_t operand_index = 0;
    std::uint64_t glyph_index = 0;

    friend bool operator==(const ContentLocation&, const ContentLocation&) = default;
};

struct SourceRange {
    ContentLocation begin{};
    ContentLocation end{};
    bool valid = false;

    friend bool operator==(const SourceRange&, const SourceRange&) = default;
};

struct GlyphPlacement {
    Matrix text_matrix{};
    Point advance{};
    double font_size = 1.0;
    double horizontal_scale = 1.0;
    double vertical_scale = 1.0;
    double rise = 0.0;
    double character_spacing = 0.0;
    double word_spacing = 0.0;
    bool is_word_space = false;
    Rect glyph_box{0.0, -200.0, 1000.0, 800.0};
    AdvanceUnits advance_units = AdvanceUnits::ThousandthsOfEm;
    bool vertical = false;
    GlyphMapping mapping{};
    SourceRange source{};
};

struct GlyphGeometry {
    Point origin{};
    Point advance{};
    Point x_axis{};
    Point y_axis{};
    std::array<Point, 4> quad{};
    Rect bounds{};
    Matrix text_rendering_matrix{};
    Matrix normalized_transform{};
    double determinant = 1.0;
    bool mirrored = false;
    bool vertical = false;
    GlyphMapping mapping{};
    SourceRange source{};
};

[[nodiscard]] GlyphGeometry glyph_from_text_rendering_matrix(
    const Matrix& text_rendering_matrix,
    const Rect& glyph_box_text_space,
    Point advance_user_space,
    const PageGeometry& page,
    bool vertical,
    GlyphMapping mapping,
    SourceRange source);

[[nodiscard]] GlyphGeometry normalize_glyph(
    const GlyphPlacement& placement,
    const PageGeometry& page);

[[nodiscard]] std::vector<GlyphGeometry> normalize_glyphs(
    std::span<const GlyphPlacement> placements,
    const PageGeometry& page);

enum class GeometrySortOrder {
    Auto,
    HorizontalRows,
    VerticalColumns,
};

struct SortOptions {
    GeometrySortOrder order = GeometrySortOrder::Auto;
    double line_tolerance = 0.6;
    bool reverse_major = false;
    bool reverse_minor = false;
};

void sort_by_geometry(std::vector<GlyphGeometry>& glyphs, const SortOptions& options = {});

struct IntervalOptions {
    double line_tolerance = 0.6;
    double gap_factor = 1.5;
    double gap_epsilon = 0.0;
};

struct TextInterval {
    std::size_t first_glyph = 0;
    std::size_t glyph_count = 0;
    Rect bounds{};
    bool vertical = false;
    std::string text;
    std::vector<GlyphMapping> mappings;
    std::vector<SourceRange> sources;
    SourceRange source{};
};

[[nodiscard]] std::vector<TextInterval> build_text_intervals(
    const std::vector<GlyphGeometry>& sorted_glyphs,
    const IntervalOptions& options = {});

class GeometryNormalizer {
public:
    explicit GeometryNormalizer(PageGeometry page);

    [[nodiscard]] const PageGeometry& page() const noexcept { return page_; }
    [[nodiscard]] GlyphGeometry normalize(const GlyphPlacement& placement) const;
    [[nodiscard]] std::vector<GlyphGeometry> normalize(
        std::span<const GlyphPlacement> placements) const;
    [[nodiscard]] std::vector<TextInterval> normalize_and_sort(
        std::span<const GlyphPlacement> placements,
        const SortOptions& sort_options = {},
        const IntervalOptions& interval_options = {}) const;

private:
    PageGeometry page_;
};

}  // namespace dataeng
