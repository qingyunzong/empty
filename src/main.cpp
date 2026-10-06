// Demo: the classic stale-holder fault, plus bounded fault-trace exploration.

#include <fencesim/explore.hpp>
#include <fencesim/fence.hpp>

#include <iostream>

using namespace fencesim;

static void print_evidence(const FenceService& service, const Storage& storage) {
    std::cout << "== grant evidence ==\n";
    for (const auto& g : service.grants()) {
        std::cout << "grant  token=" << g.token << " holder=" << g.holder
                  << " at=" << g.granted_at << " lease_until=" << g.lease_until
                  << "\n";
    }
    std::cout << "== write evidence ==\n";
    for (const auto& w : storage.log()) {
        std::cout << "write  token=" << w.token << " holder=" << w.holder
                  << " at=" << w.at << " value=" << w.value << " -> "
                  << (w.accepted ? "ACCEPTED" : "REJECTED") << "\n";
    }
}

int main() {
    constexpr Tick kLease = 5;
    FenceService service(kLease);
    Storage storage;

    // Holder 0 acquires a lease, then stalls past its expiry.
    Token stale = service.grant(0, /*now=*/0);
    // Holder 1 arrives after holder 0's lease has expired.
    Token fresh = service.grant(1, /*now=*/6);
    storage.write(fresh, 1, /*at=*/6, "payload-from-holder-1");
    // Holder 0 wakes up and attempts its late write: must be fenced out.
    bool late_accepted = storage.write(stale, 0, /*at=*/7, "stale-payload");

    print_evidence(service, storage);
    std::cout << "== outcome ==\n";
    std::cout << "late write accepted: " << std::boolalpha << late_accepted << "\n";
    std::cout << "stale lease valid at t=7: " << service.lease_valid(stale, 7)
              << " (expiry does not roll back storage)\n";
    std::cout << "stored value: " << storage.value()
              << " (highest token " << storage.highest_token() << ")\n";

    ExploreConfig cfg;
    ExploreResult res = explore(cfg);
    std::cout << "== bounded exploration (holders=" << cfg.holders
              << ", max_time=" << cfg.max_time << ") ==\n";
    std::cout << "traces: " << res.traces << ", states: " << res.states << "\n";
    std::cout << "accepted writes: " << res.accepted_writes
              << ", rejected writes: " << res.rejected_writes
              << " (stale-lease rejections: " << res.stale_rejections << ")\n";
    std::cout << "invariant: " << (res.invariant_ok ? "OK" : "VIOLATED") << "\n";
    if (!res.invariant_ok) std::cout << "violation: " << res.first_violation << "\n";
    return res.invariant_ok && !late_accepted ? 0 : 1;
}
