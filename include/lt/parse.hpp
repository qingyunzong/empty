#pragma once

#include "lt/model.hpp"

#include <istream>
#include <string>

namespace lt {

// Parses the line-based object format:
//   object <name>
//   section <name> size=<n> align=<n> [keep]
//   data <section> <offset> <hexbytes>
//   sym <name> <strong|weak> def <section> <offset>
//   sym <name> <strong|weak> undef
//   reloc <section> <offset> <ABS32|ABS64|PC32> <symbol> [addend]
// Lines may be blank or start with '#'. Throws std::runtime_error on error.
Object parse_object(std::istream& in, const std::string& source_name);

Object parse_object_file(const std::string& path);

} // namespace lt
