#pragma once

#include "lt/link.hpp"
#include "lt/model.hpp"

#include <string>
#include <vector>

namespace lt {

// Full-graph interpreter: an independent reference implementation that
// re-resolves symbols and re-evaluates relocations over the *entire* object
// graph (no GC), then cross-checks the linker's output:
//   1. its own resolution agrees with every binding in the linker's evidence;
//   2. its own reachability closure equals the linker's kept-section set;
//   3. re-interpreting each kept section's relocations at the linked
//      addresses reproduces the linked bytes exactly.
// Returns a list of mismatch descriptions; empty means the link is verified.
std::vector<std::string> interpret_check(const LinkResult& result,
                                         const LinkOptions& opts);

} // namespace lt
