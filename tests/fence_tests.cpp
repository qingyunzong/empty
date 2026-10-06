// Assert-based tests; registered with CTest. No external test framework.

#include <fencesim/explore.hpp>
#include <fencesim/fence.hpp>

#include <cstdlib>
#include <iostream>
#include <string>

using namespace fencesim;

static int failures = 0;

#define CHECK(cond)                                                            \
    do {                                                                       \
        if (!(cond)) {                                                         \
            ++failures;                                                        \
            std::cerr << "FAIL " << __FILE__ << ":" << __LINE__ << " "         \
                      << #cond << "\n";                                        \
        }                                                                      \
    } while (0)

static void test_monotonic_grants() {
    FenceService svc(/*lease_duration=*/5);
    Token t1 = svc.grant(0, 0);
    Token t2 = svc.grant(1, 0);
    Token t3 = svc.grant(0, 3);
    CHECK(t1 < t2 && t2 < t3);
    CHECK(svc.grants().size() == 3);
    CHECK(svc.grants()[1].holder == 1);
    CHECK(svc.grants()[2].lease_until == 8);
}

static void test_storage_fencing_rule() {
    Storage st;
    CHECK(st.write(10, 0, 0, "a"));
    CHECK(st.write(10, 0, 1, "a-retry")); // equal token: idempotent retry
    CHECK(st.write(11, 1, 2, "b"));
    CHECK(!st.write(9, 2, 3, "stale"));   // lower token: fenced out
    CHECK(st.value() == "b");
    CHECK(st.highest_token() == 11);
    CHECK(st.log().size() == 4);
    CHECK(!st.log()[3].accepted);
}

static void test_lease_expiry_does_not_revoke_storage() {
    FenceService svc(/*lease_duration=*/5);
    Storage st;
    Token t = svc.grant(0, 0);
    CHECK(st.write(t, 0, 1, "kept"));
    // Clock passes the lease deadline; storage must be untouched.
    CHECK(!svc.lease_valid(t, 10));
    CHECK(st.value() == "kept");
    CHECK(st.highest_token() == t);
}

static void test_stale_holder_late_write_rejected() {
    FenceService svc(/*lease_duration=*/5);
    Storage st;
    Token old = svc.grant(0, 0);          // holder 0 leases, then stalls
    Token neo = svc.grant(1, 6);          // holder 1 leases after expiry
    CHECK(st.write(neo, 1, 6, "fresh"));
    CHECK(!st.write(old, 0, 7, "late"));  // late write from stale holder
    CHECK(st.value() == "fresh");
    // Evidence: the rejection is on record.
    const auto& log = st.log();
    CHECK(log.size() == 2 && !log.back().accepted && log.back().token == old);
}

static void test_bounded_exploration() {
    ExploreConfig cfg{/*lease_duration=*/5, /*max_time=*/12, /*holders=*/2};
    ExploreResult res = explore(cfg);
    CHECK(res.invariant_ok);
    CHECK(res.traces > 0);
    CHECK(res.accepted_writes > 0);
    // Faults are observable: some schedules reject a write, and some of those
    // rejections are late writes whose lease had already expired.
    CHECK(res.rejected_writes > 0);
    CHECK(res.stale_rejections > 0);
}

static void test_three_holder_exploration() {
    ExploreConfig cfg{/*lease_duration=*/4, /*max_time=*/10, /*holders=*/3};
    ExploreResult res = explore(cfg);
    CHECK(res.invariant_ok);
    CHECK(res.traces > 0);
}

int main() {
    test_monotonic_grants();
    test_storage_fencing_rule();
    test_lease_expiry_does_not_revoke_storage();
    test_stale_holder_late_write_rejected();
    test_bounded_exploration();
    test_three_holder_exploration();
    if (failures == 0) {
        std::cout << "all tests passed\n";
        return EXIT_SUCCESS;
    }
    std::cerr << failures << " check(s) failed\n";
    return EXIT_FAILURE;
}
