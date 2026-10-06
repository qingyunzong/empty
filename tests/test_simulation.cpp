#include "test_util.hpp"

#include <fencing/simulation.hpp>
#include <fencing/verifier.hpp>

int main() {
  using namespace fencing;
  Simulation sim(/*lease_ttl=*/100);

  // Holder A takes the lease and commits a value.
  Token ta = sim.grant_lease(1);
  CHECK(sim.write(1, ta, 10));

  // Lease expires; expiry must not revoke the stored result.
  sim.advance(150);
  CHECK(sim.storage().read().has_value() && *sim.storage().read() == 10);

  // Holder B takes over with a strictly larger token and writes.
  Token tb = sim.grant_lease(2);
  CHECK(tb > ta);
  CHECK(sim.write(2, tb, 20));

  // Old holder A's late write is rejected as stale; B's value survives.
  CHECK(!sim.write(1, ta, 11));
  CHECK(*sim.storage().read() == 20);
  CHECK(sim.storage().accepted_token() == tb);

  // Expired-lease and unknown-token writes are refused too.
  CHECK(!sim.write(1, ta, 12));
  CHECK(!sim.write(9, 999, 0));

  // A crashed holder cannot write until it recovers.
  sim.crash(2);
  CHECK(!sim.write(2, tb, 21));
  sim.recover(2);

  // Once tb's lease has also expired, recovery alone is not enough.
  sim.advance(200);
  CHECK(!sim.write(2, tb, 21));
  CHECK(*sim.storage().read() == 20);

  // Evidence trail: grants, expiries, accepted and rejected writes.
  const Trace& trace = sim.trace();
  CHECK(trace.select<LeaseGranted>().size() == 2);
  CHECK(trace.select<LeaseExpired>().size() == 2);
  CHECK(trace.select<WriteAccepted>().size() == 2);
  auto rejected = trace.select<WriteRejected>();
  CHECK(rejected.size() == 5);
  bool saw_stale = false;
  for (const auto& r : rejected) {
    if (r.reason == RejectReason::StaleToken && r.holder == 1 && r.token == ta) {
      saw_stale = true;
    }
  }
  CHECK(saw_stale);

  // Bounded-fault verification: 2 expiries + 1 crash = 3 faults.
  auto result = verify_bounded_faults(trace, 3);
  CHECK(result.ok());
  CHECK(result.fault_count == 3);
  // A tighter bound must fail.
  CHECK(!verify_bounded_faults(trace, 2).ok());

  return 0;
}
