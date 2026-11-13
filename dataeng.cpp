#include "dataeng.hpp"

#include <algorithm>
#include <cmath>
#include <numeric>
#include <utility>

namespace dataeng {
namespace {

constexpr double kEpsilon = 1e-12;

int normalize_rotation(int rotate) {
    int normalized = rotate % 360;
    if (normalized < 0) {
        normalized += 360;
    }
    if (normalized % 90 != 0) {
        throw std::invalid_argument("page rotation must be a multiple of 90 degrees");
    }
    return normalized;
}

double nonnegative(double value) {
    return value < 0.0 ? 0.0 : value;
}

double median(std::vector<double> values) {
    if (values.empty()) {
        return 0.0;
    }
    const auto middle = values.begin() + static_cast<std::ptrdiff_t>(values.size() / 2);
    std::nth_element(values.begin(), middle, values.end());
    return *middle;
}

Point unit_or_zero(Point vector) {
    const double magnitude = std::hypot(vector.x, vector.y);
    if (magnitude <= kEpsilon) {
        return {};
    }
    return {vector.x / magnitude, vector.y / magnitude};
}

bool runs_downward(const GlyphGeometry& glyph) {
    const Point direction =
        std::hypot(glyph.advance.x, glyph.advance.y) > kEpsilon ? glyph.advance
                                                                : glyph.x_axis;
    return std::abs(direction.y) > std::abs(direction.x);
}

bool is_column_layout(const std::vector<GlyphGeometry>& glyphs) {
    std::size_t downward = 0;
    std::size_t applicable = 0;
    for (const GlyphGeometry& glyph : glyphs) {
        if (std::hypot(glyph.advance.x, glyph.advance.y) <= kEpsilon
            && std::hypot(glyph.x_axis.x, glyph.x_axis.y) <= kEpsilon) {
            continue;
        }
        ++applicable;
        if (runs_downward(glyph)) {
            ++downward;
        }
    }
    return applicable > 0 && downward * 2 > applicable;
}

void append_utf8(std::string& output, std::uint32_t codepoint) {
    if (codepoint > 0x10ffff || (codepoint >= 0xd800 && codepoint <= 0xdfff)) {
        return;
    }
    if (codepoint <= 0x7f) {
        output.push_back(static_cast<char>(codepoint));
    } else if (codepoint <= 0x7ff) {
        output.push_back(static_cast<char>(0xc0 | (codepoint >> 6)));
        output.push_back(static_cast<char>(0x80 | (codepoint & 0x3f)));
    } else if (codepoint <= 0xffff) {
        output.push_back(static_cast<char>(0xe0 | (codepoint >> 12)));
        output.push_back(static_cast<char>(0x80 | ((codepoint >> 6) & 0x3f)));
        output.push_back(static_cast<char>(0x80 | (codepoint & 0x3f)));
    } else {
        output.push_back(static_cast<char>(0xf0 | (codepoint >> 18)));
        output.push_back(static_cast<char>(0x80 | ((codepoint >> 12) & 0x3f)));
        output.push_back(static_cast<char>(0x80 | ((codepoint >> 6) & 0x3f)));
        output.push_back(static_cast<char>(0x80 | (codepoint & 0x3f)));
    }
}

std::string mapping_text(const GlyphMapping& mapping) {
    if (!mapping.text.empty()) {
        return mapping.text;
    }
    std::string text;
    for (const std::uint32_t codepoint : mapping.codepoints) {
        append_utf8(text, codepoint);
    }
    return text;
}

bool same_line(const GlyphGeometry& lhs, const GlyphGeometry& rhs, double tolerance) {
    const double reference = std::max({lhs.bounds.height(), rhs.bounds.height(), 1.0});
    return std::abs(lhs.bounds.center().y - rhs.bounds.center().y)
           <= tolerance * reference;
}

bool same_column(const GlyphGeometry& lhs, const GlyphGeometry& rhs, double tolerance) {
    const double reference = std::max({lhs.bounds.width(), rhs.bounds.width(), 1.0});
    return std::abs(lhs.bounds.center().x - rhs.bounds.center().x)
           <= tolerance * reference;
}

struct Group {
    double center = 0.0;
    double low = 0.0;
    double high = 0.0;
    std::vector<std::size_t> members;
};

std::vector<Group> group_rows(
    const std::vector<GlyphGeometry>& glyphs,
    std::vector<std::size_t> indices,
    double tolerance) {
    std::sort(indices.begin(), indices.end(), [&](std::size_t lhs, std::size_t rhs) {
        const Rect& lhs_bounds = glyphs[lhs].bounds;
        const Rect& rhs_bounds = glyphs[rhs].bounds;
        if (lhs_bounds.y0 != rhs_bounds.y0) {
            return lhs_bounds.y0 < rhs_bounds.y0;
        }
        if (lhs_bounds.x0 != rhs_bounds.x0) {
            return lhs_bounds.x0 < rhs_bounds.x0;
        }
        return glyphs[lhs].origin.y < glyphs[rhs].origin.y;
    });

    std::vector<double> heights;
    heights.reserve(glyphs.size());
    for (const GlyphGeometry& glyph : glyphs) {
        heights.push_back(nonnegative(glyph.bounds.height()));
    }
    const double median_height = median(std::move(heights));
    const double group_radius = tolerance * std::max(median_height, 1.0);

    std::vector<Group> groups;
    groups.reserve(indices.size());
    for (const std::size_t index : indices) {
        const Point center = glyphs[index].bounds.center();
        bool attached = false;
        for (Group& group : groups) {
            if (std::abs(center.y - group.center) <= group_radius) {
                group.members.push_back(index);
                group.center =
                    (group.center * static_cast<double>(group.members.size() - 1)
                     + center.y)
                    / static_cast<double>(group.members.size());
                group.low = std::min(group.low, glyphs[index].bounds.y0);
                group.high = std::max(group.high, glyphs[index].bounds.y1);
                attached = true;
                break;
            }
        }
        if (!attached) {
            groups.push_back(
                Group{center.y, glyphs[index].bounds.y0, glyphs[index].bounds.y1, {index}});
        }
    }
    return groups;
}

std::vector<Group> group_columns(
    const std::vector<GlyphGeometry>& glyphs,
    std::vector<std::size_t> indices,
    double tolerance) {
    std::sort(indices.begin(), indices.end(), [&](std::size_t lhs, std::size_t rhs) {
        const Rect& lhs_bounds = glyphs[lhs].bounds;
        const Rect& rhs_bounds = glyphs[rhs].bounds;
        if (lhs_bounds.x0 != rhs_bounds.x0) {
            return lhs_bounds.x0 < rhs_bounds.x0;
        }
        if (lhs_bounds.y0 != rhs_bounds.y0) {
            return lhs_bounds.y0 < rhs_bounds.y0;
        }
        return glyphs[lhs].origin.x < glyphs[rhs].origin.x;
    });

    std::vector<double> widths;
    widths.reserve(glyphs.size());
    for (const GlyphGeometry& glyph : glyphs) {
        widths.push_back(nonnegative(glyph.bounds.width()));
    }
    const double median_width = median(std::move(widths));
    const double group_radius = tolerance * std::max(median_width, 1.0);

    std::vector<Group> groups;
    groups.reserve(indices.size());
    for (const std::size_t index : indices) {
        const Point center = glyphs[index].bounds.center();
        bool attached = false;
        for (Group& group : groups) {
            if (std::abs(center.x - group.center) <= group_radius) {
                group.members.push_back(index);
                group.center =
                    (group.center * static_cast<double>(group.members.size() - 1)
                     + center.x)
                    / static_cast<double>(group.members.size());
                group.low = std::min(group.low, glyphs[index].bounds.x0);
                group.high = std::max(group.high, glyphs[index].bounds.x1);
                attached = true;
                break;
            }
        }
        if (!attached) {
            groups.push_back(
                Group{center.x, glyphs[index].bounds.x0, glyphs[index].bounds.x1, {index}});
        }
    }
    return groups;
}

void append_interval(
    std::vector<TextInterval>& intervals,
    const std::vector<GlyphGeometry>& glyphs,
    std::size_t first,
    std::size_t last) {
    TextInterval interval;
    interval.first_glyph = first;
    interval.glyph_count = last - first + 1;
    interval.vertical = glyphs[first].vertical;
    interval.bounds = glyphs[first].bounds;

    bool has_source = false;
    bool source_conflict = false;
    for (std::size_t index = first; index <= last; ++index) {
        const GlyphGeometry& glyph = glyphs[index];
        interval.bounds = unite(interval.bounds, glyph.bounds);
        interval.text += mapping_text(glyph.mapping);
        interval.mappings.push_back(glyph.mapping);
        interval.sources.push_back(glyph.source);
        if (!glyph.source.valid) {
            continue;
        }
        if (!has_source) {
            interval.source = glyph.source;
            has_source = true;
            continue;
        }
        if (glyph.source.begin.page_index != interval.source.begin.page_index
            || glyph.source.begin.stream_index != interval.source.begin.stream_index) {
            source_conflict = true;
            continue;
        }
        if (glyph.source.begin.stream_offset < interval.source.begin.stream_offset) {
            interval.source.begin = glyph.source.begin;
        }
        if (glyph.source.end.stream_offset > interval.source.end.stream_offset) {
            interval.source.end = glyph.source.end;
        }
    }

    if (!has_source || source_conflict) {
        interval.source = {};
    }
    intervals.push_back(std::move(interval));
}

}  // namespace

Rect normalized_rect(const Rect& rect) noexcept {
    return {std::min(rect.x0, rect.x1),
            std::min(rect.y0, rect.y1),
            std::max(rect.x0, rect.x1),
            std::max(rect.y0, rect.y1)};
}

Rect unite(const Rect& lhs, const Rect& rhs) noexcept {
    return {std::min(lhs.x0, rhs.x0),
            std::min(lhs.y0, rhs.y0),
            std::max(lhs.x1, rhs.x1),
            std::max(lhs.y1, rhs.y1)};
}

Point Matrix::apply(Point point) const noexcept {
    return {a * point.x + c * point.y + e, b * point.x + d * point.y + f};
}

Point Matrix::apply_vector(Point vector) const noexcept {
    return {a * vector.x + c * vector.y, b * vector.x + d * vector.y};
}

Rect Matrix::apply(const Rect& rect) const noexcept {
    const std::array<Point, 4> corners{
        apply(Point{rect.x0, rect.y0}),
        apply(Point{rect.x1, rect.y0}),
        apply(Point{rect.x1, rect.y1}),
        apply(Point{rect.x0, rect.y1}),
    };
    Rect result{corners[0].x, corners[0].y, corners[0].x, corners[0].y};
    for (const Point& corner : corners) {
        result = unite(result, {corner.x, corner.y, corner.x, corner.y});
    }
    return result;
}

bool Matrix::is_invertible() const noexcept {
    return std::abs(determinant()) > kEpsilon;
}

Matrix Matrix::inverse() const {
    const double det = determinant();
    if (std::abs(det) <= kEpsilon) {
        throw std::invalid_argument("matrix is singular");
    }
    const double inv_det = 1.0 / det;
    Matrix result;
    result.a = d * inv_det;
    result.b = -b * inv_det;
    result.c = -c * inv_det;
    result.d = a * inv_det;
    result.e = (c * f - d * e) * inv_det;
    result.f = (b * e - a * f) * inv_det;
    return result;
}

Matrix translation(double tx, double ty) noexcept {
    return {1.0, 0.0, 0.0, 1.0, tx, ty};
}

Matrix scaling(double sx, double sy) noexcept {
    return {sx, 0.0, 0.0, sy, 0.0, 0.0};
}

Matrix concatenate(const Matrix& first, const Matrix& second) noexcept {
    return {
        first.a * second.a + first.c * second.b,
        first.b * second.a + first.d * second.b,
        first.a * second.c + first.c * second.d,
        first.b * second.c + first.d * second.d,
        first.a * second.e + first.c * second.f + first.e,
        first.b * second.e + first.d * second.f + first.f,
    };
}

PageGeometry::PageGeometry()
    : media_box_{0.0, 0.0, 612.0, 792.0}, crop_box_{0.0, 0.0, 612.0, 792.0} {}

PageGeometry::PageGeometry(Rect crop_box, int rotate)
    : media_box_(normalized_rect(crop_box)),
      crop_box_(normalized_rect(crop_box)),
      rotation_(normalize_rotation(rotate)) {
    if (crop_box_.empty()) {
        throw std::invalid_argument("crop box must have positive width and height");
    }
}

PageGeometry::PageGeometry(Rect media_box, std::optional<Rect> crop_box, int rotate)
    : media_box_(normalized_rect(media_box)),
      crop_box_(normalized_rect(crop_box.value_or(media_box))),
      rotation_(normalize_rotation(rotate)) {
    const Rect intersection{std::max(media_box_.x0, crop_box_.x0),
                           std::max(media_box_.y0, crop_box_.y0),
                           std::min(media_box_.x1, crop_box_.x1),
                           std::min(media_box_.y1, crop_box_.y1)};
    if (intersection.empty()) {
        throw std::invalid_argument("crop box must intersect the media box");
    }
    crop_box_ = intersection;
}

PageGeometry::PageGeometry(Rect crop_box, PageRotation rotate)
    : PageGeometry(crop_box, static_cast<int>(rotate)) {}

PageGeometry::PageGeometry(
    Rect media_box,
    std::optional<Rect> crop_box,
    PageRotation rotate)
    : PageGeometry(media_box, crop_box, static_cast<int>(rotate)) {}

double PageGeometry::width() const noexcept {
    return rotation_ == 90 || rotation_ == 270 ? crop_box_.height() : crop_box_.width();
}

double PageGeometry::height() const noexcept {
    return rotation_ == 90 || rotation_ == 270 ? crop_box_.width() : crop_box_.height();
}

Matrix PageGeometry::user_to_normalized() const noexcept {
    const double crop_width = crop_box_.width();
    const double crop_height = crop_box_.height();
    switch (rotation_) {
        case 0:
            return {1.0, 0.0, 0.0, -1.0, -crop_box_.x0, crop_box_.y0 + crop_height};
        case 90:
            return {0.0, 1.0, 1.0, 0.0, -crop_box_.y0, -crop_box_.x0};
        case 180:
            return {-1.0, 0.0, 0.0, 1.0, crop_box_.x0 + crop_width, -crop_box_.y0};
        case 270:
            return {0.0, -1.0, -1.0, 0.0,
                    crop_box_.y0 + crop_height,
                    crop_box_.x0 + crop_width};
        default:
            return {};
    }
}

Matrix PageGeometry::normalized_to_user() const {
    return user_to_normalized().inverse();
}

Point PageGeometry::normalize(Point point) const noexcept {
    return user_to_normalized().apply(point);
}

Rect PageGeometry::normalize(const Rect& rect) const noexcept {
    return user_to_normalized().apply(rect);
}

Point PageGeometry::denormalize(Point point) const noexcept {
    return normalized_to_user().apply(point);
}

Rect PageGeometry::denormalize(const Rect& rect) const noexcept {
    return normalized_to_user().apply(rect);
}

GlyphGeometry glyph_from_text_rendering_matrix(
    const Matrix& text_rendering_matrix,
    const Rect& glyph_box_text_space,
    Point advance_user_space,
    const PageGeometry& page,
    bool vertical,
    GlyphMapping mapping,
    SourceRange source) {
    GlyphGeometry geometry;
    geometry.text_rendering_matrix = text_rendering_matrix;
    geometry.normalized_transform =
        concatenate(page.user_to_normalized(), text_rendering_matrix);
    geometry.determinant = text_rendering_matrix.determinant();
    geometry.mirrored = geometry.determinant < 0.0;
    geometry.vertical = vertical;
    geometry.mapping = std::move(mapping);
    geometry.source = std::move(source);

    const std::array<Point, 4> corners{
        text_rendering_matrix.apply(
            Point{glyph_box_text_space.x0, glyph_box_text_space.y0}),
        text_rendering_matrix.apply(
            Point{glyph_box_text_space.x1, glyph_box_text_space.y0}),
        text_rendering_matrix.apply(
            Point{glyph_box_text_space.x1, glyph_box_text_space.y1}),
        text_rendering_matrix.apply(
            Point{glyph_box_text_space.x0, glyph_box_text_space.y1}),
    };
    for (std::size_t index = 0; index < corners.size(); ++index) {
        geometry.quad[index] = page.normalize(corners[index]);
    }

    geometry.bounds = {geometry.quad[0].x,
                       geometry.quad[0].y,
                       geometry.quad[0].x,
                       geometry.quad[0].y};
    for (const Point& corner : geometry.quad) {
        geometry.bounds = unite(geometry.bounds, {corner.x, corner.y, corner.x, corner.y});
    }

    geometry.origin = page.normalize(text_rendering_matrix.apply(Point{0.0, 0.0}));
    geometry.advance = page.user_to_normalized().apply_vector(advance_user_space);
    geometry.x_axis = unit_or_zero(page.user_to_normalized().apply_vector(
        text_rendering_matrix.apply_vector({1.0, 0.0})));
    geometry.y_axis = unit_or_zero(page.user_to_normalized().apply_vector(
        text_rendering_matrix.apply_vector({0.0, 1.0})));
    return geometry;
}

GlyphGeometry normalize_glyph(
    const GlyphPlacement& placement,
    const PageGeometry& page) {
    Matrix text_rendering_matrix;
    Point advance_text_space;
    Rect glyph_box_text_space = placement.glyph_box;

    if (placement.advance_units == AdvanceUnits::ThousandthsOfEm) {
        const double unit_scale = 1.0 / 1000.0;
        const double x_scale = placement.font_size * placement.horizontal_scale;
        const double y_scale = placement.font_size * placement.vertical_scale;
        text_rendering_matrix = concatenate(
            placement.text_matrix,
            {x_scale, 0.0, 0.0, y_scale, 0.0, placement.rise});

        glyph_box_text_space = {placement.glyph_box.x0 * unit_scale,
                                placement.glyph_box.y0 * unit_scale,
                                placement.glyph_box.x1 * unit_scale,
                                placement.glyph_box.y1 * unit_scale};
        advance_text_space.x = placement.advance.x * unit_scale * x_scale;
        advance_text_space.y = placement.advance.y * unit_scale * y_scale;
        const double spacing =
            placement.character_spacing
            + (placement.is_word_space ? placement.word_spacing : 0.0);
        if (placement.vertical) {
            advance_text_space.y += spacing * placement.vertical_scale;
        } else {
            advance_text_space.x += spacing * placement.horizontal_scale;
        }
    } else {
        text_rendering_matrix =
            concatenate(placement.text_matrix, translation(0.0, placement.rise));
        advance_text_space = placement.advance;
    }

    const Point advance_user_space =
        placement.text_matrix.apply_vector(advance_text_space);
    return glyph_from_text_rendering_matrix(text_rendering_matrix,
                                            glyph_box_text_space,
                                            advance_user_space,
                                            page,
                                            placement.vertical,
                                            placement.mapping,
                                            placement.source);
}

std::vector<GlyphGeometry> normalize_glyphs(
    std::span<const GlyphPlacement> placements,
    const PageGeometry& page) {
    std::vector<GlyphGeometry> glyphs;
    glyphs.reserve(placements.size());
    for (const GlyphPlacement& placement : placements) {
        glyphs.push_back(normalize_glyph(placement, page));
    }
    return glyphs;
}

void sort_by_geometry(std::vector<GlyphGeometry>& glyphs, const SortOptions& options) {
    if (glyphs.size() < 2) {
        return;
    }

    std::vector<std::size_t> indices(glyphs.size());
    std::iota(indices.begin(), indices.end(), std::size_t{0});

    const bool columns =
        options.order == GeometrySortOrder::VerticalColumns
        || (options.order == GeometrySortOrder::Auto && is_column_layout(glyphs));
    std::vector<Group> groups = columns
                                    ? group_columns(glyphs, indices, options.line_tolerance)
                                    : group_rows(glyphs, indices, options.line_tolerance);

    std::sort(groups.begin(), groups.end(), [](const Group& lhs, const Group& rhs) {
        if (lhs.center != rhs.center) {
            return lhs.center < rhs.center;
        }
        if (lhs.low != rhs.low) {
            return lhs.low < rhs.low;
        }
        return lhs.high < rhs.high;
    });
    if (options.reverse_major) {
        std::reverse(groups.begin(), groups.end());
    }

    std::vector<std::size_t> ordered;
    ordered.reserve(glyphs.size());
    for (Group& group : groups) {
        std::sort(group.members.begin(),
                  group.members.end(),
                  [&](std::size_t lhs, std::size_t rhs) {
                      const Point lhs_center = glyphs[lhs].bounds.center();
                      const Point rhs_center = glyphs[rhs].bounds.center();
                      const double lhs_primary = columns ? lhs_center.y : lhs_center.x;
                      const double rhs_primary = columns ? rhs_center.y : rhs_center.x;
                      if (lhs_primary != rhs_primary) {
                          return lhs_primary < rhs_primary;
                      }
                      const double lhs_secondary = columns ? lhs_center.x : lhs_center.y;
                      const double rhs_secondary = columns ? rhs_center.x : rhs_center.y;
                      if (lhs_secondary != rhs_secondary) {
                          return lhs_secondary < rhs_secondary;
                      }
                      if (glyphs[lhs].bounds.y0 != glyphs[rhs].bounds.y0) {
                          return glyphs[lhs].bounds.y0 < glyphs[rhs].bounds.y0;
                      }
                      if (glyphs[lhs].bounds.x0 != glyphs[rhs].bounds.x0) {
                          return glyphs[lhs].bounds.x0 < glyphs[rhs].bounds.x0;
                      }
                      return glyphs[lhs].bounds.y1 < glyphs[rhs].bounds.y1;
                  });
        if (options.reverse_minor) {
            std::reverse(group.members.begin(), group.members.end());
        }
        ordered.insert(ordered.end(), group.members.begin(), group.members.end());
    }

    std::vector<GlyphGeometry> reordered;
    reordered.reserve(glyphs.size());
    for (const std::size_t index : ordered) {
        reordered.push_back(std::move(glyphs[index]));
    }
    glyphs = std::move(reordered);
}

std::vector<TextInterval> build_text_intervals(
    const std::vector<GlyphGeometry>& sorted_glyphs,
    const IntervalOptions& options) {
    std::vector<TextInterval> intervals;
    if (sorted_glyphs.empty()) {
        return intervals;
    }

    std::vector<double> heights;
    std::vector<double> widths;
    heights.reserve(sorted_glyphs.size());
    widths.reserve(sorted_glyphs.size());
    for (const GlyphGeometry& glyph : sorted_glyphs) {
        heights.push_back(nonnegative(glyph.bounds.height()));
        widths.push_back(nonnegative(glyph.bounds.width()));
    }
    const double median_height = std::max(median(std::move(heights)), 1.0);
    const double median_width = std::max(median(std::move(widths)), 1.0);
    const bool columns = is_column_layout(sorted_glyphs);

    std::size_t first = 0;
    for (std::size_t index = 1; index <= sorted_glyphs.size(); ++index) {
        bool split = index == sorted_glyphs.size();
        if (!split) {
            const GlyphGeometry& previous = sorted_glyphs[index - 1];
            const GlyphGeometry& current = sorted_glyphs[index];
            if (columns) {
                split = !same_column(previous, current, options.line_tolerance);
                const double gap = current.bounds.y0 - previous.bounds.y1;
                split = split || gap > options.gap_factor * median_height
                                      + options.gap_epsilon;
            } else {
                split = !same_line(previous, current, options.line_tolerance);
                const double gap = current.bounds.x0 - previous.bounds.x1;
                split = split || gap > options.gap_factor * median_width
                                      + options.gap_epsilon;
            }
        }
        if (split) {
            append_interval(intervals, sorted_glyphs, first, index - 1);
            first = index;
        }
    }
    return intervals;
}

GeometryNormalizer::GeometryNormalizer(PageGeometry page) : page_(std::move(page)) {}

GlyphGeometry GeometryNormalizer::normalize(const GlyphPlacement& placement) const {
    return normalize_glyph(placement, page_);
}

std::vector<GlyphGeometry> GeometryNormalizer::normalize(
    std::span<const GlyphPlacement> placements) const {
    return normalize_glyphs(placements, page_);
}

std::vector<TextInterval> GeometryNormalizer::normalize_and_sort(
    std::span<const GlyphPlacement> placements,
    const SortOptions& sort_options,
    const IntervalOptions& interval_options) const {
    std::vector<GlyphGeometry> glyphs = normalize(placements);
    sort_by_geometry(glyphs, sort_options);
    return build_text_intervals(glyphs, interval_options);
}

}  // namespace dataeng
