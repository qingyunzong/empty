// Randomized scenarios: the optimized Simulator must reproduce the
// byte-explicit ReferenceSimulator event-for-event, and byte
// conservation must hold at every tick along the way.
#include <cstdint>
#include <random>
#include <string>
#include <vector>

#include "check.hpp"
#include "reference.hpp"
#include "simulator.hpp"

namespace {

struct FlowSpec {
    int id;
    std::vector<int> path;
    std::uint64_t size;
    netsim::Tick added;
    bool cancelled;
    netsim::Tick cancel_tick;
};

struct Scenario {
    std::vector<std::uint64_t> bandwidths;
    std::vector<FlowSpec> flows;
};

Scenario make_scenario(std::mt19937_64& rng) {
    Scenario s;
    std::uniform_int_distribution<int> nlinks_d(1, 4);
    const int nlinks = nlinks_d(rng);
    std::uniform_int_distribution<std::uint64_t> bw_d(1, 5);
    for (int i = 0; i < nlinks; ++i) s.bandwidths.push_back(bw_d(rng));

    std::uniform_int_distribution<int> nflows_d(1, 8);
    const int nflows = nflows_d(rng);
    std::uniform_int_distribution<int> hopcount_d(1, nlinks);
    std::uniform_int_distribution<int> hopstart_d(0, nlinks - 1);
    std::uniform_int_distribution<std::uint64_t> size_d(0, 50);
    std::uniform_int_distribution<netsim::Tick> add_d(0, 5);
    std::uniform_int_distribution<netsim::Tick> cancel_d(0, 12);
    std::uniform_int_distribution<int> coin(0, 1);
    for (int i = 0; i < nflows; ++i) {
        FlowSpec f;
        f.id = 1 + i;
        const int start = hopstart_d(rng);
        const int hops = hopcount_d(rng);
        for (int h = 0; h < hops && start + h < nlinks; ++h) f.path.push_back(start + h);
        f.size = size_d(rng);
        f.added = add_d(rng);
        f.cancelled = coin(rng) == 1;
        f.cancel_tick = cancel_d(rng);
        s.flows.push_back(f);
    }
    return s;
}

}  // namespace

int main() {
    using namespace netsim;

    std::mt19937_64 rng(20261006);
    for (int iter = 0; iter < 300; ++iter) {
        const Scenario sc = make_scenario(rng);

        Simulator sim;
        ReferenceSimulator ref;
        for (std::uint64_t bw : sc.bandwidths) {
            sim.add_link(bw);
            ref.add_link(bw);
        }
        for (const FlowSpec& f : sc.flows) {
            sim.add_flow(f.id, f.path, f.size, f.added);
            ref.add_flow(f.id, f.path, f.size, f.added);
            if (f.cancelled) {
                sim.cancel_flow(f.id, f.cancel_tick);
                ref.cancel_flow(f.id, f.cancel_tick);
            }
        }

        // Step the main simulator one tick at a time, checking byte
        // conservation after every single tick.
        for (int t = 0; t < 200 && !sim.finished(); ++t) {
            sim.run(1);
            std::string err;
            CHECK(sim.check_conservation(err));
        }
        CHECK(sim.finished());

        const std::vector<ByteEvent> ref_events = ref.run(200);
        if (sim.events() != ref_events) {
            std::cerr << "event stream mismatch in scenario " << iter << "\n";
            CHECK_EQ(sim.events().size(), ref_events.size());
            for (std::size_t i = 0; i < sim.events().size(); ++i) {
                CHECK(sim.events()[i] == ref_events[i]);
            }
        }

        const auto acct = sim.accounting();
        const auto ref_results = ref.results();
        CHECK_EQ(acct.size(), ref_results.size());
        for (std::size_t i = 0; i < acct.size(); ++i) {
            CHECK_EQ(acct[i].flow_id, ref_results[i].flow_id);
            CHECK_EQ(acct[i].delivered, ref_results[i].delivered);
            CHECK_EQ(acct[i].cancelled, ref_results[i].cancelled);
            CHECK_EQ(acct[i].delivered + acct[i].cancelled, acct[i].size);
            CHECK_EQ(acct[i].in_flight, 0u);
            CHECK_EQ(acct[i].unsent, 0u);
            CHECK(acct[i].completed);
        }
    }
    return 0;
}
