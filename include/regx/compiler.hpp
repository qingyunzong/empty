#pragma once

#include "regx/ast.hpp"
#include "regx/bytecode.hpp"

namespace regx {

// Compiles a parsed expression into a verified stack-machine program.
// Short-circuit operators (&&, ||, ?:) lower to conditional jumps; the
// emitted program is run through verify() before being returned.
Program compile(const Expr& root, const Schema& schema);

} // namespace regx
