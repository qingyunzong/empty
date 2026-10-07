#include "model.hpp"

#include <deque>
#include <sstream>

namespace dl {

const char* toString(Mode m) {
    return m == Mode::Shared ? "shared" : "exclusive";
}

const char* toString(Kind k) {
    switch (k) {
        case Kind::Wait: return "wait";
        case Kind::Acquire: return "acquire";
        case Kind::Release: return "release";
    }
    return "?";
}

ParseResult parseLine(const std::string& raw, std::size_t lineNo) {
    ParseResult result;
    std::istringstream in(raw);
    std::string thread, op, lock, mode;
    if (!(in >> thread)) {
        return result;  // blank line
    }
    if (thread.front() == '#') {
        return result;  // comment
    }
    if (!(in >> op >> lock)) {
        result.error = "expected: <thread> <wait|acquire|release> <lock> [shared|exclusive]";
        return result;
    }
    Event ev;
    ev.line = lineNo;
    ev.raw = raw;
    ev.thread = thread;
    ev.lock = lock;
    if (op == "wait") {
        ev.kind = Kind::Wait;
    } else if (op == "acquire") {
        ev.kind = Kind::Acquire;
    } else if (op == "release") {
        ev.kind = Kind::Release;
    } else {
        result.error = "unknown operation '" + op + "' (expected wait|acquire|release)";
        return result;
    }
    if (in >> mode) {
        if (mode == "shared") {
            ev.mode = Mode::Shared;
        } else if (mode == "exclusive") {
            ev.mode = Mode::Exclusive;
        } else {
            result.error = "unknown mode '" + mode + "' (expected shared|exclusive)";
            return result;
        }
    } else if (ev.kind != Kind::Release) {
        result.error = "missing lock mode (shared|exclusive)";
        return result;
    }
    std::string extra;
    if (in >> extra) {
        result.error = "unexpected trailing token '" + extra + "'";
        return result;
    }
    result.isEvent = true;
    result.event = std::move(ev);
    return result;
}

std::size_t Engine::intern(const std::string& name) {
    auto [it, inserted] = ids_.emplace(name, names_.size());
    if (inserted) {
        names_.push_back(name);
    }
    return it->second;
}

std::optional<Cycle> Engine::step(const Event& ev) {
    Event e = ev;
    e.index = events_.size();
    events_.push_back(e);
    const std::size_t tid = intern(e.thread);

    switch (e.kind) {
        case Kind::Wait:
            // A thread blocks on one request at a time; a new wait supersedes
            // any earlier still-ungranted request by the same thread.
            waiting_[tid] = PendingWait{e.lock, e.mode, e.index};
            break;
        case Kind::Acquire:
            held_[e.lock][tid] = Hold{e.mode, e.index};
            if (auto it = waiting_.find(tid);
                it != waiting_.end() && it->second.lock == e.lock) {
                waiting_.erase(it);
            }
            break;
        case Kind::Release:
            if (auto it = held_.find(e.lock); it != held_.end()) {
                it->second.erase(tid);
                if (it->second.empty()) {
                    held_.erase(it);
                }
            }
            break;
    }

    rebuildGraph();
    return shortestCycle(edges_, names_.size());
}

void Engine::rebuildGraph() {
    edges_.clear();
    std::map<std::pair<std::size_t, std::size_t>, std::size_t> edgePos;
    for (const auto& [tid, wait] : waiting_) {
        auto heldIt = held_.find(wait.lock);
        if (heldIt == held_.end()) {
            continue;  // nobody holds the lock: the wait is not blocked by a holder
        }
        for (const auto& [holder, hold] : heldIt->second) {
            // Exclusive waits are blocked by every holder; shared waits only
            // by exclusive holders. A holder may be the waiter itself (e.g. a
            // shared->exclusive upgrade against its own shared hold).
            const bool conflict =
                wait.mode == Mode::Exclusive || hold.mode == Mode::Exclusive;
            if (!conflict) {
                continue;
            }
            EdgeLabel label{wait.lock, wait.event, hold.event};
            auto key = std::make_pair(tid, holder);
            auto [pos, inserted] = edgePos.emplace(key, edges_.size());
            if (inserted) {
                edges_.push_back(Edge{tid, holder, {label}});
            } else {
                edges_[pos->second].labels.push_back(label);
            }
        }
    }
}

std::optional<Cycle> shortestCycle(const std::vector<Edge>& edges, std::size_t nodeCount) {
    if (edges.empty()) {
        return std::nullopt;
    }
    std::vector<std::vector<std::size_t>> adj(nodeCount);  // edge indices
    for (std::size_t i = 0; i < edges.size(); ++i) {
        adj[edges[i].from].push_back(i);
    }

    std::optional<Cycle> best;
    for (std::size_t start = 0; start < edges.size(); ++start) {
        const Edge& e0 = edges[start];
        if (best && best->nodes.size() <= 1) {
            break;  // cannot beat a self-loop
        }
        // BFS from e0.to back to e0.from, skipping edge `start` itself.
        const std::size_t target = e0.from;
        if (e0.to == target) {
            best = Cycle{{target}, {e0}};
            continue;
        }
        std::vector<std::size_t> parentEdge(nodeCount, static_cast<std::size_t>(-1));
        std::vector<bool> seen(nodeCount, false);
        std::deque<std::size_t> queue;
        seen[e0.to] = true;
        queue.push_back(e0.to);
        bool found = false;
        while (!queue.empty() && !found) {
            const std::size_t u = queue.front();
            queue.pop_front();
            for (const std::size_t ei : adj[u]) {
                if (ei == start) {
                    continue;
                }
                const std::size_t v = edges[ei].to;
                if (v == target) {
                    parentEdge[v] = ei;
                    found = true;
                    break;
                }
                if (!seen[v]) {
                    seen[v] = true;
                    parentEdge[v] = ei;
                    queue.push_back(v);
                }
            }
        }
        if (!found) {
            continue;
        }
        // Rebuild path edges target-wards: walk from target back via parentEdge.
        std::vector<std::size_t> pathEdges;
        for (std::size_t v = target; v != e0.to;) {
            const std::size_t ei = parentEdge[v];
            pathEdges.push_back(ei);
            v = edges[ei].from;
        }
        Cycle cyc;
        cyc.edges.push_back(e0);
        cyc.nodes.push_back(e0.from);
        cyc.nodes.push_back(e0.to);
        for (auto it = pathEdges.rbegin(); it != pathEdges.rend(); ++it) {
            cyc.edges.push_back(edges[*it]);
            if (edges[*it].to != target) {
                cyc.nodes.push_back(edges[*it].to);
            }
        }
        if (!best || cyc.nodes.size() < best->nodes.size()) {
            best = std::move(cyc);
        }
    }
    return best;
}

}  // namespace dl
