#pragma once

#include "regx/ast.hpp"

#include <cstdint>
#include <unordered_map>

namespace regx {

using RegValues = std::unordered_map<std::string, uint64_t>;

// Direct AST evaluation. Throws RuntimeError when an executed register read
// finds a missing register or a value that does not fit its declared width.
// &&, || and ?: short-circuit: unexecuted branches never raise.
uint64_t eval(const Expr& e, const RegValues& regs);

} // namespace regx
