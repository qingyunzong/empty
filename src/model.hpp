#pragma once

#include <cstddef>
#include <cstdint>
#include <map>
#include <optional>
#include <string>
#include <vector>

namespace lw {

enum class Mode { Shared, Exclusive };

const char* to_string(Mode m);

enum class OpType { Request, Grant, Release, Cancel };

struct Event {
    OpType op = OpType::Request;
    std::uint64_t time = 0;
    std::string thread;           // REQ only
    std::string call;             // REQ/GNT/REL/CAN
    std::string lock;             // REQ only
    Mode mode = Mode::Exclusive;  // REQ only
    std::size_t index = 0;        // 1-based event number (line order)
};

// Parses one log line. Returns false and sets err on malformed input.
// Blank lines and '#' comments set skip=true and return true.
bool parse_line(const std::string& line, std::size_t index, Event& out,
                bool& skip, std::string& err);

enum class CallState { Pending, Granted, Released, Cancelled };

struct Call {
    std::string id;
    std::string thread;
    std::string lock;
    Mode mode = Mode::Exclusive;
    CallState state = CallState::Pending;
    std::size_t req_event = 0;
    std::size_t grant_event = 0;
    std::size_t end_event = 0;

    bool operator==(const Call&) const = default;
};

// A wait-for edge: thread `from` is blocked by thread `to`.
struct Edge {
    std::string from;
    std::string to;
    std::string lock;
    Mode wait_mode = Mode::Exclusive;
    Mode hold_mode = Mode::Exclusive;
    std::string waiter_call;
    std::string holder_call;
    std::size_t waiter_req_event = 0;   // source event: the blocking request
    std::size_t holder_grant_event = 0; // source event: the conflicting grant
};

// A deadlock cycle. threads has no repeated tail; edges[i] goes
// threads[i] -> threads[(i+1) % size].
struct Cycle {
    std::vector<std::string> threads;
    std::vector<Edge> edges;
};

// Full lock/Wait state reconstructed from an event prefix.
class Model {
public:
    // Applies one event. Returns false and sets err on semantic errors
    // (unknown call id, double grant, etc.).
    bool apply(const Event& ev, std::string& err);

    const std::map<std::string, Call>& calls() const { return calls_; }

    // Derives the full wait-for graph from current state.
    // An exclusive waiter is blocked by every holder of the lock;
    // a shared waiter is blocked only by exclusive holders.
    // A thread never blocks itself (e.g. lock upgrades).
    std::vector<Edge> wait_for_edges() const;

    // Shortest cycle in the wait-for graph (fewest threads; ties broken
    // deterministically by lexicographic order of the thread sequence).
    std::optional<Cycle> shortest_cycle() const;

    bool same_state(const Model& other) const { return calls_ == other.calls_; }

    // Replays an event prefix into a fresh model (used for verification).
    static Model replay(const std::vector<Event>& events);

private:
    std::map<std::string, Call> calls_;
};

// Replays an ordered log, maintaining the model incrementally and, after
// every event, re-deriving the full state from scratch to verify the
// incremental model (per-moment full-graph checking).
class Engine {
public:
    explicit Engine(bool verify_each_moment = true)
        : verify_each_moment_(verify_each_moment) {}

    // Returns false and sets err on parse/semantic/order errors or on a
    // verification mismatch between the incremental and replayed models.
    bool apply(const Event& ev, std::string& err);

    const Model& model() const { return model_; }
    const std::vector<Event>& history() const { return history_; }
    std::size_t moments_verified() const { return moments_verified_; }

private:
    Model model_;
    std::vector<Event> history_;
    std::uint64_t last_time_ = 0;
    bool has_time_ = false;
    bool verify_each_moment_;
    std::size_t moments_verified_ = 0;
};

} // namespace lw
