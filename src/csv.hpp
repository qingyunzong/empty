#pragma once

#include <string>
#include <string_view>
#include <vector>

namespace numimport {

using Row = std::vector<std::string>;
using Table = std::vector<Row>;

// Minimal RFC 4180 style CSV: comma delimiter, double-quoted fields with
// "" escapes, CRLF or LF line endings, embedded newlines inside quotes.
Table parse_csv(std::string_view input);

// Serializes with LF line endings, quoting fields only when required.
std::string serialize_csv(const Table& table);

} // namespace numimport
