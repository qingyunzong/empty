#include "test_util.hpp"

#include <fencing/storage.hpp>

int main() {
  using namespace fencing;
  Trace trace;
  FencingStorage storage;

  // Accept a write, then reject anything below the accepted fence.
  CHECK(storage.write(1, 5, 42, 0, trace));
  CHECK(storage.read().has_value() && *storage.read() == 42);
  CHECK(!storage.write(2, 4, 99, 1, trace));
  CHECK(*storage.read() == 42);

  // Equal token is accepted (idempotent retry of the same epoch).
  CHECK(storage.write(1, 5, 43, 2, trace));
  CHECK(*storage.read() == 43);

  // Higher token advances the fence.
  CHECK(storage.write(3, 6, 100, 3, trace));
  CHECK(storage.accepted_token() == 6);
  CHECK(*storage.read() == 100);

  // Evidence matches outcomes.
  CHECK(trace.select<WriteAccepted>().size() == 3);
  auto rejected = trace.select<WriteRejected>();
  CHECK(rejected.size() == 1);
  CHECK(rejected[0].reason == RejectReason::StaleToken && rejected[0].token == 4);

  return 0;
}
