#pragma once

#include "regx/bytecode.hpp"

namespace regx {

struct VerifyError : Error {
  using Error::Error;
};

// Abstractly interprets the program from the entry point and checks that
// every reachable instruction has a single, consistent stack type (sequence
// of value widths). In particular every jump target is entered with the
// same stack shape from all predecessors. Also checks stack underflow,
// jump target bounds, slice/width legality, and that Halt is reached with
// exactly the result value on the stack.
void verify(const Program& prog);

} // namespace regx
