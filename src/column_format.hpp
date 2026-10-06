#pragma once

#include "number_parser.hpp"

#include <string>
#include <vector>

namespace numimport {

enum class ColumnStatus {
    Ok,        // one consistent interpretation exists (or both agree)
    Ambiguous, // both interpretations are valid but yield different values
    Invalid,   // neither interpretation fits every non-empty cell
};

struct ColumnDecision {
    ColumnStatus status = ColumnStatus::Ok;
    char decimalChar = '.';       // meaningful when status == Ok
    size_t problemRow = 0;        // first row demonstrating the problem
    std::string problemToken;     // token at problemRow
};

// Decides a single decimal separator for an entire column. Every non-empty
// cell is tried under both interpretations; the decision never depends on
// the first row alone. Empty cells are ignored for the decision.
ColumnDecision decideColumn(const std::vector<std::string>& cells);

// Converts one cell with the column's decimal separator into its exact
// fraction string. Empty cells stay empty.
std::string convertCell(const std::string& cell, char decimalChar);

} // namespace numimport
