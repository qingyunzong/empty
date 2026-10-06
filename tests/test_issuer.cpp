#include "test_util.hpp"

#include <fencing/issuer.hpp>

int main() {
  using namespace fencing;
  Trace trace;
  TokenIssuer issuer;

  // First grant succeeds, tokens start at 1.
  auto t1 = issuer.grant(7, 0, 100, trace);
  CHECK(t1.has_value() && *t1 == 1);
  CHECK(issuer.lease_valid_at(*t1, 50));
  CHECK(!issuer.lease_valid_at(*t1, 100));

  // Grant while the lease is still valid is refused.
  CHECK(!issuer.grant(8, 50, 100, trace).has_value());

  // After expiry the next grant succeeds with a strictly larger token.
  auto t2 = issuer.grant(8, 150, 100, trace);
  CHECK(t2.has_value() && *t2 == 2);
  CHECK(*t2 > *t1);

  // Evidence: two grants and one lazy expiry of the first lease.
  CHECK(trace.select<LeaseGranted>().size() == 2);
  auto expired = trace.select<LeaseExpired>();
  CHECK(expired.size() == 1);
  CHECK(expired[0].token == *t1 && expired[0].holder == 7);

  return 0;
}
