#include "column_format.hpp"

#include <optional>

namespace numimport {

ColumnDecision decideColumn(const std::vector<std::string>& cells) {
    const char decimals[2] = {'.', ','};
    bool ok[2] = {true, true};
    size_t failRow[2] = {0, 0};
    std::vector<std::optional<ExactNumber>> values[2];

    for (int c = 0; c < 2; ++c) {
        values[c].assign(cells.size(), std::nullopt);
        for (size_t r = 0; r < cells.size(); ++r) {
            if (cells[r].empty()) continue;
            auto parsed = parseNumber(cells[r], decimals[c]);
            if (!parsed) {
                ok[c] = false;
                failRow[c] = r;
                break;
            }
            values[c][r] = std::move(*parsed);
        }
    }

    ColumnDecision decision;
    if (ok[0] && ok[1]) {
        for (size_t r = 0; r < cells.size(); ++r) {
            if (cells[r].empty()) continue;
            if (values[0][r] != values[1][r]) {
                decision.status = ColumnStatus::Ambiguous;
                decision.problemRow = r;
                decision.problemToken = cells[r];
                return decision;
            }
        }
        decision.decimalChar = '.'; // both agree; either interpretation works
        return decision;
    }
    if (ok[0] || ok[1]) {
        decision.decimalChar = ok[0] ? '.' : ',';
        return decision;
    }
    decision.status = ColumnStatus::Invalid;
    decision.problemRow = failRow[0] <= failRow[1] ? failRow[0] : failRow[1];
    decision.problemToken = cells[decision.problemRow];
    return decision;
}

std::string convertCell(const std::string& cell, char decimalChar) {
    if (cell.empty()) return {};
    const auto value = parseNumber(cell, decimalChar);
    return value ? toString(*value) : cell; // decided columns always parse
}

} // namespace numimport
