#include "test_util.hpp"

#include <fencing/verifier.hpp>

using namespace fencing;

static Trace valid_trace() {
  Trace t;
  t.record(LeaseGranted{1, 1, 0, 100});
  t.record(WriteAccepted{1, 1, 10, 5});
  t.record(LeaseExpired{1, 1, 100});
  t.record(LeaseGranted{2, 2, 150, 250});
  t.record(WriteAccepted{2, 2, 20, 160});
  t.record(WriteRejected{1, 1, 11, 170, RejectReason::StaleToken});
  return t;
}

int main() {
  // A well-formed trace passes with a matching fault bound.
  CHECK(verify_bounded_faults(valid_trace(), 1).ok());
  CHECK(!verify_bounded_faults(valid_trace(), 0).ok());

  // Non-monotonic grant.
  {
    Trace t = valid_trace();
    t.record(LeaseGranted{3, 2, 300, 400});
    CHECK(!verify_bounded_faults(t, 5).ok());
  }
  // Storage accepts a stale token (late write from old holder slips through).
  {
    Trace t = valid_trace();
    t.record(WriteAccepted{1, 1, 99, 180});
    CHECK(!verify_bounded_faults(t, 5).ok());
  }
  // Accepted write with a token nobody was granted.
  {
    Trace t = valid_trace();
    t.record(WriteAccepted{4, 9, 1, 180});
    CHECK(!verify_bounded_faults(t, 5).ok());
  }
  // Accepted write from the wrong holder.
  {
    Trace t = valid_trace();
    t.record(WriteAccepted{3, 2, 1, 180});
    CHECK(!verify_bounded_faults(t, 5).ok());
  }
  // Accepted write after the lease expired.
  {
    Trace t = valid_trace();
    t.record(WriteAccepted{2, 2, 21, 300});
    CHECK(!verify_bounded_faults(t, 5).ok());
  }
  // Forged stale rejection of a token at/above the fence.
  {
    Trace t = valid_trace();
    t.record(WriteRejected{2, 2, 21, 180, RejectReason::StaleToken});
    CHECK(!verify_bounded_faults(t, 5).ok());
  }
  // Fault bound exceeded.
  {
    Trace t = valid_trace();
    t.record(HolderCrashed{2, 200});
    CHECK(!verify_bounded_faults(t, 1).ok());
    CHECK(verify_bounded_faults(t, 2).ok());
  }
  return 0;
}
