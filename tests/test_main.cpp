// Scenario-based tests for the lock wait-for graph diagnostic.
// Each scenario is registered as its own CTest test via argv[1].
#include "model.hpp"

#include <cstring>
#include <iostream>
#include <map>
#include <sstream>
#include <string>
#include <vector>

namespace {

int failures = 0;

#define CHECK(cond)                                                        \
    do {                                                                   \
        if (!(cond)) {                                                     \
            std::cerr << "CHECK failed at line " << __LINE__ << ": " #cond \
                      << "\n";                                             \
            ++failures;                                                    \
        }                                                                  \
    } while (0)

std::vector<lw::Event> parse_log(const std::string& text) {
    std::vector<lw::Event> events;
    std::istringstream in(text);
    std::string line;
    std::size_t index = 0;
    while (std::getline(in, line)) {
        ++index;
        lw::Event ev;
        bool skip = false;
        std::string err;
        if (!lw::parse_line(line, index, ev, skip, err)) {
            std::cerr << "parse error in test log: " << err << "\n";
            ++failures;
            continue;
        }
        if (!skip)
        {
            ev.index = events.size() + 1; // ordinal among events
            events.push_back(ev);
        }
    }
    return events;
}

// Runs the engine over the log, recording after each event whether a
// deadlock cycle exists. Verification is on, so any divergence between
// the incremental model and a full replay fails the run.
struct Run {
    std::vector<std::optional<lw::Cycle>> per_moment;
    bool ok = true;
    std::string err;
    std::size_t verified = 0;
};

Run run_log(const std::string& text) {
    Run run;
    lw::Engine engine(true);
    for (const lw::Event& ev : parse_log(text)) {
        std::string err;
        if (!engine.apply(ev, err)) {
            run.ok = false;
            run.err = err;
            return run;
        }
        run.per_moment.push_back(engine.model().shortest_cycle());
    }
    run.verified = engine.moments_verified();
    return run;
}

// Two threads, two locks, classic exclusive deadlock.
int basic_xy_deadlock() {
    Run run = run_log(R"(
REQ 1 T1 c1 L1 X
GNT 2 c1
REQ 3 T2 c2 L2 X
GNT 4 c2
REQ 5 T1 c3 L2 X
REQ 6 T2 c4 L1 X
)");
    CHECK(run.ok);
    CHECK(run.per_moment.size() == 6);
    for (std::size_t i = 0; i < 5; ++i)
        CHECK(!run.per_moment[i].has_value());
    CHECK(run.per_moment[5].has_value());
    if (run.per_moment[5]) {
        const lw::Cycle& c = *run.per_moment[5];
        CHECK(c.threads.size() == 2);
        CHECK(c.edges.size() == 2);
        CHECK(c.threads[0] == "T1" && c.threads[1] == "T2");
        // Source events: T1 waits via req #5 on T2's grant #4,
        // T2 waits via req #6 on T1's grant #2.
        CHECK(c.edges[0].from == "T1" && c.edges[0].to == "T2");
        CHECK(c.edges[0].waiter_req_event == 5);
        CHECK(c.edges[0].holder_grant_event == 4);
        CHECK(c.edges[0].lock == "L2");
        CHECK(c.edges[1].from == "T2" && c.edges[1].to == "T1");
        CHECK(c.edges[1].waiter_req_event == 6);
        CHECK(c.edges[1].holder_grant_event == 2);
        CHECK(c.edges[1].lock == "L1");
    }
    CHECK(run.verified == 6);
    return failures;
}

// Shared holders do not block shared waiters; exclusive waiters are
// blocked by every holder.
int shared_vs_exclusive_blocking() {
    Run run = run_log(R"(
REQ 1 T1 c1 L1 S
GNT 2 c1
REQ 3 T2 c2 L1 S
GNT 4 c2
REQ 5 T3 c3 L1 X
)");
    CHECK(run.ok);
    CHECK(!run.per_moment[2].has_value()); // T2's S wait not blocked by S
    CHECK(!run.per_moment[4].has_value()); // T3 blocked, but no cycle
    lw::Engine engine(false);
    for (const lw::Event& ev : parse_log(R"(
REQ 1 T1 c1 L1 S
GNT 2 c1
REQ 3 T2 c2 L1 S
GNT 4 c2
REQ 5 T3 c3 L1 X
)")) {
        std::string err;
        CHECK(engine.apply(ev, err));
    }
    auto edges = engine.model().wait_for_edges();
    CHECK(edges.size() == 2); // T3 -> T1 and T3 -> T2 (all holders)
    for (const auto& e : edges) {
        CHECK(e.from == "T3");
        CHECK(e.wait_mode == lw::Mode::Exclusive);
        CHECK(e.hold_mode == lw::Mode::Shared);
    }
    return failures;
}

// A shared waiter is blocked by an exclusive holder.
int shared_wait_blocked_by_exclusive() {
    lw::Engine engine(false);
    for (const lw::Event& ev : parse_log(R"(
REQ 1 T1 c1 L1 X
GNT 2 c1
REQ 3 T2 c2 L1 S
)")) {
        std::string err;
        CHECK(engine.apply(ev, err));
    }
    auto edges = engine.model().wait_for_edges();
    CHECK(edges.size() == 1);
    if (edges.size() == 1) {
        CHECK(edges[0].from == "T2" && edges[0].to == "T1");
        CHECK(edges[0].wait_mode == lw::Mode::Shared);
        CHECK(edges[0].hold_mode == lw::Mode::Exclusive);
    }
    return failures;
}

// Both readers upgrade to exclusive: each blocks the other, but a thread
// never blocks itself.
int upgrade_deadlock() {
    Run run = run_log(R"(
REQ 1 T1 c1 L S
GNT 2 c1
REQ 3 T2 c2 L S
GNT 4 c2
REQ 5 T1 c3 L X
REQ 6 T2 c4 L X
)");
    CHECK(run.ok);
    CHECK(!run.per_moment[4].has_value()); // only T1 -> T2 so far
    CHECK(run.per_moment[5].has_value());
    if (run.per_moment[5]) {
        CHECK(run.per_moment[5]->threads.size() == 2);
        CHECK(run.per_moment[5]->edges[0].wait_mode == lw::Mode::Exclusive);
        CHECK(run.per_moment[5]->edges[0].hold_mode == lw::Mode::Shared);
    }
    return failures;
}

// Requests without grants are waiters, never holders: no edges, no cycle.
int unfinished_call_not_holder() {
    Run run = run_log(R"(
REQ 1 T1 c1 L1 X
REQ 2 T2 c2 L1 X
REQ 3 T3 c3 L1 X
)");
    CHECK(run.ok);
    for (const auto& m : run.per_moment)
        CHECK(!m.has_value());
    lw::Engine engine(false);
    for (const lw::Event& ev : parse_log("REQ 1 T1 c1 L1 X\n")) {
        std::string err;
        CHECK(engine.apply(ev, err));
    }
    CHECK(engine.model().wait_for_edges().empty());
    const auto& calls = engine.model().calls();
    CHECK(calls.at("c1").state == lw::CallState::Pending);
    return failures;
}

// A release dissolves the cycle; the first deadlock moment is still found.
int release_breaks_cycle() {
    Run run = run_log(R"(
REQ 1 T1 c1 L1 X
GNT 2 c1
REQ 3 T2 c2 L2 X
GNT 4 c2
REQ 5 T1 c3 L2 X
REQ 6 T2 c4 L1 X
REL 7 c2
)");
    CHECK(run.ok);
    CHECK(run.per_moment[5].has_value());
    CHECK(!run.per_moment[6].has_value());
    return failures;
}

// With both a 2-cycle and a 3-cycle present, the shortest one wins.
int shortest_cycle_wins() {
    Run run = run_log(R"(
REQ 1 T1 c1 A X
GNT 2 c1
REQ 3 T2 c2 B X
GNT 4 c2
REQ 5 T3 c3 C X
GNT 6 c3
REQ 7 T1 c4 B X
REQ 8 T2 c5 C X
REQ 9 T3 c6 A X
REQ 10 T2 c7 A X
)");
    CHECK(run.ok);
    CHECK(run.per_moment[8].has_value());
    CHECK(run.per_moment[8]->threads.size() == 3); // only the 3-cycle yet
    CHECK(run.per_moment[9].has_value());
    if (run.per_moment[9]) {
        const lw::Cycle& c = *run.per_moment[9];
        CHECK(c.threads.size() == 2); // T1 <-> T2 beats T1 -> T2 -> T3
        CHECK(c.threads[0] == "T1" && c.threads[1] == "T2");
    }
    return failures;
}

// One thread holding several locks blocks waiters on each of them.
int multi_lock_holder() {
    Run run = run_log(R"(
REQ 1 T1 c1 A X
GNT 2 c1
REQ 3 T1 c2 B S
GNT 4 c2
REQ 5 T2 c3 A S
REQ 6 T3 c4 B X
REQ 7 T2 c5 C X
GNT 8 c5
REQ 9 T1 c6 C X
)");
    CHECK(run.ok);
    CHECK(run.per_moment[8].has_value());
    if (run.per_moment[8]) {
        const lw::Cycle& c = *run.per_moment[8];
        CHECK(c.threads.size() == 2); // T1 <-> T2 via C and A
    }
    return failures;
}

// Cancelling a pending request removes its wait edges.
int cancel_removes_waiter() {
    Run run = run_log(R"(
REQ 1 T1 c1 L1 X
GNT 2 c1
REQ 3 T2 c2 L2 X
GNT 4 c2
REQ 5 T1 c3 L2 X
REQ 6 T2 c4 L1 X
CAN 7 c4
)");
    CHECK(run.ok);
    CHECK(run.per_moment[5].has_value());
    CHECK(!run.per_moment[6].has_value());
    return failures;
}

// Engine-level checks: per-moment verification passes on a long mixed log,
// and out-of-order timestamps are rejected.
int per_moment_verification() {
    Run run = run_log(R"(
REQ 1 T1 a1 L1 X
GNT 2 a1
REQ 3 T2 a2 L2 S
GNT 4 a2
REQ 5 T3 a3 L2 S
GNT 6 a3
REQ 7 T1 a4 L2 X
CAN 8 a4
REQ 9 T2 a5 L1 S
CAN 10 a5
REQ 11 T3 a6 L1 X
REL 12 a1
GNT 13 a6
REL 14 a6
REL 15 a2
REL 16 a3
)");
    CHECK(run.ok);
    CHECK(run.verified == run.per_moment.size());
    CHECK(run.verified == 16);
    for (const auto& m : run.per_moment)
        CHECK(!m.has_value());

    lw::Engine engine(true);
    std::string err;
    auto evs = parse_log("REQ 5 T1 c1 L1 X\nGNT 4 c1\n");
    CHECK(engine.apply(evs[0], err));
    CHECK(!engine.apply(evs[1], err)); // time went backwards
    return failures;
}

// Semantic errors are reported, not silently accepted.
int semantic_errors() {
    lw::Engine engine(true);
    std::string err;
    auto evs = parse_log("GNT 1 nope\n");
    CHECK(!engine.apply(evs[0], err));

    lw::Engine engine2(true);
    evs = parse_log("REQ 1 T1 c1 L1 X\nREQ 2 T2 c1 L2 X\n");
    CHECK(engine2.apply(evs[0], err));
    CHECK(!engine2.apply(evs[1], err)); // duplicate call id

    lw::Engine engine3(true);
    evs = parse_log("REQ 1 T1 c1 L1 X\nREL 2 c1\n");
    CHECK(engine3.apply(evs[0], err));
    CHECK(!engine3.apply(evs[1], err)); // release of non-granted call
    return failures;
}

const std::map<std::string, int (*)()> kScenarios = {
    {"basic_xy_deadlock", basic_xy_deadlock},
    {"shared_vs_exclusive_blocking", shared_vs_exclusive_blocking},
    {"shared_wait_blocked_by_exclusive", shared_wait_blocked_by_exclusive},
    {"upgrade_deadlock", upgrade_deadlock},
    {"unfinished_call_not_holder", unfinished_call_not_holder},
    {"release_breaks_cycle", release_breaks_cycle},
    {"shortest_cycle_wins", shortest_cycle_wins},
    {"multi_lock_holder", multi_lock_holder},
    {"cancel_removes_waiter", cancel_removes_waiter},
    {"per_moment_verification", per_moment_verification},
    {"semantic_errors", semantic_errors},
};

} // namespace

int main(int argc, char** argv) {
    if (argc != 2) {
        std::cerr << "usage: lockwait_tests <scenario>\navailable:";
        for (const auto& [name, fn] : kScenarios)
            std::cerr << " " << name;
        std::cerr << "\n";
        return 2;
    }
    auto it = kScenarios.find(argv[1]);
    if (it == kScenarios.end()) {
        std::cerr << "unknown scenario '" << argv[1] << "'\n";
        return 2;
    }
    int rc = it->second();
    if (rc == 0)
        std::cout << "PASS " << argv[1] << "\n";
    else
        std::cerr << "FAIL " << argv[1] << " (" << rc << " check(s))\n";
    return rc == 0 ? 0 : 1;
}
