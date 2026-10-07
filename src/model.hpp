#pragma once

#include <cstddef>
#include <map>
#include <optional>
#include <string>
#include <utility>
#include <vector>

namespace dl {

enum class Mode { Shared, Exclusive };
enum class Kind { Wait, Acquire, Release };

const char* toString(Mode m);
const char* toString(Kind k);

struct Event {
    std::size_t line = 0;   // 1-based line number in the source log
    std::size_t index = 0;  // 0-based sequence number among parsed events
    std::string raw;        // original log line
    std::string thread;
    Kind kind = Kind::Wait;
    std::string lock;
    Mode mode = Mode::Exclusive;  // meaningful for Wait/Acquire
};

struct ParseResult {
    bool isEvent = false;  // false for blank lines and '#' comments
    Event event;
    std::string error;     // non-empty on malformed input
};

ParseResult parseLine(const std::string& raw, std::size_t lineNo);

struct EdgeLabel {
    std::string lock;
    std::size_t waitEvent = 0;    // event index of the blocked wait
    std::size_t holderEvent = 0;  // event index of the holder's acquire
};

struct Edge {
    std::size_t from = 0;  // waiting thread id
    std::size_t to = 0;    // holder thread id
    std::vector<EdgeLabel> labels;
};

struct Cycle {
    std::vector<std::size_t> nodes;  // n thread ids; edges close the loop
    std::vector<Edge> edges;         // edges[i]: nodes[i] -> nodes[(i+1) % n]
};

// Rebuilds the full wait-for graph from lock state after every event
// (point-in-time full-graph model; nothing is inferred incrementally).
class Engine {
public:
    // Applies one event, rebuilds the complete wait-for graph, and returns
    // the shortest deadlock cycle if one exists at this moment.
    std::optional<Cycle> step(const Event& ev);

    const std::vector<std::string>& threadNames() const { return names_; }
    const std::vector<Edge>& edges() const { return edges_; }
    const std::vector<Event>& events() const { return events_; }

private:
    struct Hold { Mode mode; std::size_t event; };
    struct PendingWait { std::string lock; Mode mode; std::size_t event; };

    std::size_t intern(const std::string& name);
    void rebuildGraph();

    std::vector<std::string> names_;
    std::map<std::string, std::size_t> ids_;
    std::map<std::string, std::map<std::size_t, Hold>> held_;  // lock -> thread -> hold
    std::map<std::size_t, PendingWait> waiting_;               // thread -> pending wait
    std::vector<Event> events_;
    std::vector<Edge> edges_;
};

// Shortest directed cycle (fewest edges) over the given wait-for edges.
std::optional<Cycle> shortestCycle(const std::vector<Edge>& edges, std::size_t nodeCount);

}  // namespace dl
