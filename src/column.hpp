#pragma once

#include "numparse.hpp"

#include <string>
#include <vector>

namespace numimport {

enum class ColumnKind {
    numeric,     // every non-empty cell is a number under the chosen separator
    empty_only,  // no non-empty cells
    non_numeric, // at least one cell is not a number under either interpretation
};

enum class ColumnError {
    none,
    inconsistent, // cells need different separators; none fits the whole column
    ambiguous,    // both separators fit the whole column but values differ
};

struct ColumnDecision {
    ColumnKind kind = ColumnKind::empty_only;
    DecimalSep sep = DecimalSep::dot; // meaningful when kind == numeric
    ColumnError error = ColumnError::none;
    std::size_t error_row = 0; // 1-based row evidencing the error
    std::string error_cell;
};

// Decides a single decimal separator for an entire column by examining every
// non-empty cell (never just the first row). Empty cells impose no constraint.
ColumnDecision decide_column(const std::vector<std::string>& cells);

} // namespace numimport
