#include <iostream>
#include <optional>
#include <string>

#include "model.hpp"

namespace {

int failures = 0;

void check(bool cond, const std::string& name) {
    if (!cond) {
        ++failures;
        std::cerr << "FAIL: " << name << "\n";
    }
}

dl::Event ev(const std::string& thread, const std::string& op,
             const std::string& lock, dl::Mode mode = dl::Mode::Exclusive) {
    dl::Event e;
    e.thread = thread;
    e.lock = lock;
    e.mode = mode;
    if (op == "wait") e.kind = dl::Kind::Wait;
    else if (op == "acquire") e.kind = dl::Kind::Acquire;
    else e.kind = dl::Kind::Release;
    return e;
}

void testParse() {
    check(!dl::parseLine("", 1).isEvent, "blank line is not an event");
    check(!dl::parseLine("   ", 1).isEvent, "whitespace line is not an event");
    check(!dl::parseLine("# comment", 1).isEvent, "comment is not an event");

    auto wait = dl::parseLine("T1 wait L1 exclusive", 7);
    check(wait.isEvent && wait.error.empty(), "wait line parses");
    check(wait.event.thread == "T1" && wait.event.lock == "L1" &&
              wait.event.kind == dl::Kind::Wait && wait.event.mode == dl::Mode::Exclusive &&
              wait.event.line == 7,
          "wait fields");

    auto acq = dl::parseLine("T2 acquire L2 shared", 1);
    check(acq.isEvent && acq.event.mode == dl::Mode::Shared, "acquire shared parses");

    auto rel = dl::parseLine("T1 release L1", 1);
    check(rel.isEvent && rel.event.kind == dl::Kind::Release, "release parses");

    check(!dl::parseLine("T1 wait L1", 1).error.empty(), "wait without mode rejected");
    check(!dl::parseLine("T1 frob L1 shared", 1).error.empty(), "bad op rejected");
    check(!dl::parseLine("T1 wait L1 bogus", 1).error.empty(), "bad mode rejected");
    check(!dl::parseLine("T1 wait L1 shared extra", 1).error.empty(),
          "trailing token rejected");
    check(!dl::parseLine("T1 wait", 1).error.empty(), "missing lock rejected");
}

void testBlockingRules() {
    {  // shared wait vs shared holder: compatible, no edge
        dl::Engine e;
        e.step(ev("T1", "acquire", "L", dl::Mode::Shared));
        auto cyc = e.step(ev("T2", "wait", "L", dl::Mode::Shared));
        check(e.edges().empty(), "shared wait not blocked by shared holder");
        check(!cyc, "no cycle for compatible shared");
    }
    {  // shared wait vs exclusive holder: blocked
        dl::Engine e;
        e.step(ev("T1", "acquire", "L", dl::Mode::Exclusive));
        e.step(ev("T2", "wait", "L", dl::Mode::Shared));
        check(e.edges().size() == 1, "shared wait blocked by exclusive holder");
    }
    {  // exclusive wait vs shared holder: blocked
        dl::Engine e;
        e.step(ev("T1", "acquire", "L", dl::Mode::Shared));
        e.step(ev("T2", "wait", "L", dl::Mode::Exclusive));
        check(e.edges().size() == 1, "exclusive wait blocked by shared holder");
    }
    {  // exclusive wait vs exclusive holder: blocked
        dl::Engine e;
        e.step(ev("T1", "acquire", "L", dl::Mode::Exclusive));
        e.step(ev("T2", "wait", "L", dl::Mode::Exclusive));
        check(e.edges().size() == 1, "exclusive wait blocked by exclusive holder");
    }
    {  // exclusive wait blocked by ALL holders of a shared lock
        dl::Engine e;
        e.step(ev("T1", "acquire", "L", dl::Mode::Shared));
        e.step(ev("T2", "acquire", "L", dl::Mode::Shared));
        e.step(ev("T3", "wait", "L", dl::Mode::Exclusive));
        check(e.edges().size() == 2, "exclusive wait blocked by all shared holders");
    }
}

void testTwoThreadDeadlock() {
    dl::Engine e;
    check(!e.step(ev("T1", "acquire", "L1")), "no deadlock after T1 holds L1");
    check(!e.step(ev("T2", "acquire", "L2")), "no deadlock after T2 holds L2");
    check(!e.step(ev("T1", "wait", "L2")), "no deadlock while only T1 waits");
    auto cyc = e.step(ev("T2", "wait", "L1"));
    check(cyc.has_value(), "deadlock once T2 waits on L1");
    if (cyc) {
        check(cyc->nodes.size() == 2, "cycle has 2 threads");
        check(cyc->edges.size() == 2, "cycle has 2 edges");
        // Edge labels must point back at the exact source events.
        bool sawL1 = false, sawL2 = false;
        for (const auto& edge : cyc->edges) {
            for (const auto& label : edge.labels) {
                if (label.lock == "L1") {
                    sawL1 = true;
                    check(label.waitEvent == 3 && label.holderEvent == 0,
                          "L1 edge cites wait event 3 and holder event 0");
                }
                if (label.lock == "L2") {
                    sawL2 = true;
                    check(label.waitEvent == 2 && label.holderEvent == 1,
                          "L2 edge cites wait event 2 and holder event 1");
                }
            }
        }
        check(sawL1 && sawL2, "cycle covers both locks");
    }
}

void testReleaseResolves() {
    dl::Engine e;
    e.step(ev("T1", "acquire", "L1"));
    e.step(ev("T2", "acquire", "L2"));
    e.step(ev("T1", "wait", "L2"));
    check(e.step(ev("T2", "wait", "L1")).has_value(), "deadlock forms");
    check(!e.step(ev("T1", "release", "L1")).has_value(),
          "release breaks the cycle");
    check(e.edges().size() == 1, "only the still-blocked edge remains");
}

void testIncompleteCallsNotGranted() {
    dl::Engine e;
    // Nobody ever acquires anything; waits alone must not fabricate holders.
    check(!e.step(ev("T1", "wait", "L1")), "ungranted wait is not a hold");
    check(!e.step(ev("T2", "wait", "L2")), "second ungranted wait");
    check(!e.step(ev("T1", "wait", "L2")), "T1 still holds nothing");
    check(!e.step(ev("T2", "wait", "L1")), "no holders -> no edges -> no cycle");
    check(e.edges().empty(), "no edges without holders");

    // A pending wait that is later granted becomes a hold from that moment.
    auto before = e.step(ev("T1", "acquire", "L1"));
    check(!before.has_value(), "grant alone makes no cycle");
    check(e.edges().size() == 1 && e.edges()[0].labels[0].holderEvent == 4,
          "T2 now blocked by T1's fresh acquire (event 4)");
}

void testMultiLockHolder() {
    dl::Engine e;
    e.step(ev("T1", "acquire", "L1"));
    e.step(ev("T1", "acquire", "L2"));  // one thread, two locks
    e.step(ev("T2", "wait", "L1"));
    e.step(ev("T3", "wait", "L2"));
    check(e.edges().size() == 2, "both waiters blocked by the multi-lock holder");
    for (const auto& edge : e.edges()) {
        check(edge.to == 0, "both edges point at holder T1");
    }
}

void testShortestCycleWins() {
    dl::Engine e;
    // 2-cycle: A <-> B on locks X1/X2.
    e.step(ev("A", "acquire", "X1"));
    e.step(ev("B", "acquire", "X2"));
    e.step(ev("A", "wait", "X2"));
    e.step(ev("B", "wait", "X1"));
    // 3-cycle: C -> D -> E -> C on locks Y1/Y2/Y3.
    e.step(ev("C", "acquire", "Y1"));
    e.step(ev("D", "acquire", "Y2"));
    e.step(ev("E", "acquire", "Y3"));
    e.step(ev("C", "wait", "Y2"));
    e.step(ev("D", "wait", "Y3"));
    auto cyc = e.step(ev("E", "wait", "Y1"));
    check(cyc.has_value(), "cycles exist");
    if (cyc) {
        check(cyc->nodes.size() == 2, "shortest cycle (2) beats the 3-cycle");
    }
}

void testUpgradeSelfDeadlock() {
    dl::Engine e;
    e.step(ev("T1", "acquire", "L", dl::Mode::Shared));
    auto cyc = e.step(ev("T1", "wait", "L", dl::Mode::Exclusive));
    check(cyc.has_value(), "shared->exclusive upgrade against own hold deadlocks");
    if (cyc) {
        check(cyc->nodes.size() == 1, "self-loop cycle has one node");
    }
}

void testWaitStateTransitions() {
    {  // acquire of the waited lock clears the wait
        dl::Engine e;
        e.step(ev("T1", "acquire", "L"));
        e.step(ev("T2", "wait", "L"));
        check(e.edges().size() == 1, "T2 blocked");
        e.step(ev("T2", "acquire", "L"));
        check(e.edges().empty(), "grant clears T2's wait");
    }
    {  // a new wait supersedes an abandoned one
        dl::Engine e;
        e.step(ev("T1", "acquire", "L1"));
        e.step(ev("T2", "acquire", "L2"));
        e.step(ev("T2", "wait", "L1"));
        e.step(ev("T2", "wait", "L2"));  // abandons the L1 wait
        check(e.edges().size() == 1 && e.edges()[0].labels[0].lock == "L2",
              "superseded wait no longer blocks");
    }
    {  // release by a non-holder is a no-op
        dl::Engine e;
        e.step(ev("T1", "acquire", "L"));
        e.step(ev("T2", "release", "L"));
        e.step(ev("T3", "wait", "L"));
        check(e.edges().size() == 1, "stray release does not free the lock");
    }
}

}  // namespace

int main() {
    testParse();
    testBlockingRules();
    testTwoThreadDeadlock();
    testReleaseResolves();
    testIncompleteCallsNotGranted();
    testMultiLockHolder();
    testShortestCycleWins();
    testUpgradeSelfDeadlock();
    testWaitStateTransitions();
    if (failures == 0) {
        std::cout << "all model tests passed\n";
        return 0;
    }
    std::cerr << failures << " check(s) failed\n";
    return 1;
}
