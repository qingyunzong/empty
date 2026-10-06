#pragma once

#include "regx/ast.hpp"

#include <string>

namespace regx {

// Parses `src` against the register `schema`, computing the result width of
// every node. Throws ParseError (with byte position) on lexical, syntactic
// or static semantic errors (unknown register, illegal slice, width
// overflow, ternary branch width mismatch, ...).
ExprPtr parse(const std::string& src, const Schema& schema);

} // namespace regx
