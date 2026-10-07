#include "column.hpp"

namespace numimport {

ColumnDecision decide_column(const std::vector<std::string>& cells) {
    struct CellValues {
        std::optional<Fraction> dot;
        std::optional<Fraction> comma;
    };

    std::vector<CellValues> values;
    values.reserve(cells.size());

    bool dot_ok = true;
    bool comma_ok = true;
    bool any_number = false;

    for (std::size_t i = 0; i < cells.size(); ++i) {
        const std::string_view cell = trim(cells[i]);
        if (cell.empty()) {
            values.push_back({});
            continue;
        }
        CellValues v{parse_number(cell, DecimalSep::dot),
                     parse_number(cell, DecimalSep::comma)};
        if (!v.dot && !v.comma)
            return {ColumnKind::non_numeric, DecimalSep::dot, ColumnError::none, 0, {}};
        any_number = true;
        dot_ok = dot_ok && v.dot.has_value();
        comma_ok = comma_ok && v.comma.has_value();
        values.push_back(std::move(v));
        if (!dot_ok && !comma_ok) {
            return {ColumnKind::numeric, DecimalSep::dot, ColumnError::inconsistent,
                    i + 1, std::string(cell)};
        }
    }

    if (!any_number)
        return {ColumnKind::empty_only, DecimalSep::dot, ColumnError::none, 0, {}};

    if (dot_ok && comma_ok) {
        // Both interpretations are legal for the whole column; they are only
        // acceptable if they agree on every value.
        for (std::size_t i = 0; i < cells.size(); ++i) {
            const auto& v = values[i];
            if (v.dot && v.comma && *v.dot != *v.comma) {
                return {ColumnKind::numeric, DecimalSep::dot, ColumnError::ambiguous,
                        i + 1, std::string(trim(cells[i]))};
            }
        }
        return {ColumnKind::numeric, DecimalSep::dot, ColumnError::none, 0, {}};
    }

    return {ColumnKind::numeric, dot_ok ? DecimalSep::dot : DecimalSep::comma,
            ColumnError::none, 0, {}};
}

} // namespace numimport
