#include "column_format.hpp"
#include "number_parser.hpp"

#include <iostream>
#include <optional>
#include <string>

namespace {

int failures = 0;

#define CHECK(cond)                                                                            \
    do {                                                                                       \
        if (!(cond)) {                                                                         \
            std::cerr << "FAIL " << __FILE__ << ':' << __LINE__ << ": " #cond "\n";            \
            ++failures;                                                                        \
        }                                                                                      \
    } while (false)

std::string render(const std::optional<numimport::ExactNumber>& value) {
    return value ? numimport::toString(*value) : std::string("<invalid>");
}

void checkParse(const std::string& token, char decimal, const std::string& expected) {
    const std::string got = render(numimport::parseNumber(token, decimal));
    if (got != expected) {
        std::cerr << "FAIL parseNumber(\"" << token << "\", '" << decimal << "') = " << got
                  << ", expected " << expected << "\n";
        ++failures;
    }
}

void parserTests() {
    // Decimal separator selection.
    checkParse("1.5", '.', "3/2");
    checkParse("1.5", ',', "<invalid>");
    checkParse("1,5", ',', "3/2");
    checkParse("1,5", '.', "<invalid>");

    // Thousands separators must group in threes.
    checkParse("1,234", '.', "1234");
    checkParse("1,234,567", '.', "1234567");
    checkParse("1,23", '.', "<invalid>");
    checkParse("12,34", '.', "<invalid>");
    checkParse("1,2345", '.', "<invalid>");
    checkParse("1234,567", '.', "<invalid>"); // first group too long
    checkParse("1.234.567,89", ',', "123456789/100");
    checkParse("1.234.567,89", '.', "<invalid>");
    checkParse("2,000,000", '.', "2000000");
    checkParse("2,000,000", ',', "<invalid>");

    // Plain integers are valid under both interpretations.
    checkParse("1234", '.', "1234");
    checkParse("1234", ',', "1234");
    checkParse("007", '.', "7");

    // Signs and zero.
    checkParse("+42", '.', "42");
    checkParse("-1,234.5", '.', "-2469/2");
    checkParse("-0", '.', "0");
    checkParse("-0,00", ',', "0");
    checkParse("0,000", '.', "0");

    // Exact fractions, including reduction.
    checkParse("0.1", '.', "1/10");
    checkParse("0.25", '.', "1/4");
    checkParse("3.14159", '.', "314159/100000");
    checkParse("1,2345", ',', "2469/2000");
    checkParse("1,000,000.25", '.', "4000001/4");
    checkParse("2,000000", ',', "2");
    checkParse("99999999999999999999999999.5", '.', "199999999999999999999999999/2");

    // Malformed tokens.
    checkParse("", '.', "<invalid>");
    checkParse(".", '.', "<invalid>");
    checkParse(",", ',', "<invalid>");
    checkParse("1.", '.', "<invalid>");
    checkParse(".5", '.', "<invalid>");
    checkParse(",5", ',', "<invalid>");
    checkParse("1..2", '.', "<invalid>");
    checkParse("1,2,3", '.', "<invalid>");
    checkParse("1,2,3", ',', "<invalid>");
    checkParse("--1", '.', "<invalid>");
    checkParse("1-", '.', "<invalid>");
    checkParse("abc", '.', "<invalid>");
    checkParse("1 2", '.', "<invalid>");
    checkParse("1,234,567.89", ',', "<invalid>");
}

void checkColumn(const std::vector<std::string>& cells, numimport::ColumnStatus status,
                 char decimal) {
    const auto decision = numimport::decideColumn(cells);
    if (decision.status != status ||
        (status == numimport::ColumnStatus::Ok && decision.decimalChar != decimal)) {
        std::cerr << "FAIL decideColumn({";
        for (size_t i = 0; i < cells.size(); ++i)
            std::cerr << (i ? ", " : "") << '"' << cells[i] << '"';
        std::cerr << "})\n";
        ++failures;
    }
}

void columnTests() {
    using numimport::ColumnStatus;
    checkColumn({"1.5", "2.5"}, ColumnStatus::Ok, '.');
    checkColumn({"1,5", "2,5"}, ColumnStatus::Ok, ',');
    checkColumn({"1234", "5"}, ColumnStatus::Ok, '.'); // both agree: not ambiguous
    checkColumn({"", "1,5", ""}, ColumnStatus::Ok, ','); // empties ignored
    checkColumn({"", ""}, ColumnStatus::Ok, '.');

    // Whole column decides, never the first row alone: the second row
    // disambiguates what the first row leaves open.
    checkColumn({"1,234", "2,5"}, ColumnStatus::Ok, ',');
    checkColumn({"1,234", "2.5"}, ColumnStatus::Ok, '.');

    // Both interpretations valid but different values -> ambiguous.
    checkColumn({"1,234"}, ColumnStatus::Ambiguous, '.');
    checkColumn({"2", "1.234"}, ColumnStatus::Ambiguous, '.');

    // Neither interpretation fits every cell.
    checkColumn({"1,5", "2.5"}, ColumnStatus::Invalid, '.');
    checkColumn({"abc"}, ColumnStatus::Invalid, '.');

    // Ambiguity reporting points at the first differing row.
    const auto decision = numimport::decideColumn({"7", "1,234"});
    CHECK(decision.status == ColumnStatus::Ambiguous);
    CHECK(decision.problemRow == 1);
    CHECK(decision.problemToken == "1,234");

    // Conversion keeps empties and renders exact fractions.
    CHECK(numimport::convertCell("", '.').empty());
    CHECK(numimport::convertCell("1,5", ',') == "3/2");
    CHECK(numimport::convertCell("1,234", '.') == "1234");
}

} // namespace

int main() {
    parserTests();
    columnTests();
    if (failures == 0) {
        std::cout << "all unit tests passed\n";
        return 0;
    }
    std::cerr << failures << " failure(s)\n";
    return 1;
}
