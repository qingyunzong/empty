#include "model.hpp"

#include <algorithm>
#include <deque>
#include <set>
#include <sstream>
#include <stdexcept>

namespace lw {

const char* to_string(Mode m) {
    return m == Mode::Shared ? "S" : "X";
}

bool parse_line(const std::string& line, std::size_t index, Event& out,
                bool& skip, std::string& err) {
    skip = false;
    std::istringstream in(line);
    std::string op;
    if (!(in >> op)) {
        skip = true;
        return true;
    }
    if (!op.empty() && op[0] == '#') {
        skip = true;
        return true;
    }

    Event ev;
    ev.index = index;
    auto fail = [&](const std::string& msg) {
        err = "event #" + std::to_string(index) + ": " + msg;
        return false;
    };

    if (op == "REQ") {
        std::string mode;
        if (!(in >> ev.time >> ev.thread >> ev.call >> ev.lock >> mode))
            return fail("REQ expects: REQ <time> <thread> <call> <lock> <S|X>");
        if (mode == "S" || mode == "s" || mode == "SHARED")
            ev.mode = Mode::Shared;
        else if (mode == "X" || mode == "x" || mode == "EXCLUSIVE")
            ev.mode = Mode::Exclusive;
        else
            return fail("unknown mode '" + mode + "' (expected S or X)");
        ev.op = OpType::Request;
    } else if (op == "GNT" || op == "REL" || op == "CAN") {
        if (!(in >> ev.time >> ev.call))
            return fail(op + " expects: " + op + " <time> <call>");
        ev.op = op == "GNT"   ? OpType::Grant
                : op == "REL" ? OpType::Release
                              : OpType::Cancel;
    } else {
        return fail("unknown op '" + op + "'");
    }

    std::string extra;
    if (in >> extra)
        return fail("unexpected trailing token '" + extra + "'");

    out = std::move(ev);
    return true;
}

bool Model::apply(const Event& ev, std::string& err) {
    auto fail = [&](const std::string& msg) {
        err = "event #" + std::to_string(ev.index) + ": " + msg;
        return false;
    };
    switch (ev.op) {
    case OpType::Request: {
        if (calls_.count(ev.call))
            return fail("duplicate call id '" + ev.call + "'");
        Call c;
        c.id = ev.call;
        c.thread = ev.thread;
        c.lock = ev.lock;
        c.mode = ev.mode;
        c.state = CallState::Pending;
        c.req_event = ev.index;
        calls_.emplace(ev.call, std::move(c));
        return true;
    }
    case OpType::Grant: {
        auto it = calls_.find(ev.call);
        if (it == calls_.end())
            return fail("GNT for unknown call '" + ev.call + "'");
        if (it->second.state != CallState::Pending)
            return fail("GNT for call '" + ev.call + "' that is not pending");
        it->second.state = CallState::Granted;
        it->second.grant_event = ev.index;
        return true;
    }
    case OpType::Release: {
        auto it = calls_.find(ev.call);
        if (it == calls_.end())
            return fail("REL for unknown call '" + ev.call + "'");
        if (it->second.state != CallState::Granted)
            return fail("REL for call '" + ev.call + "' that is not granted");
        it->second.state = CallState::Released;
        it->second.end_event = ev.index;
        return true;
    }
    case OpType::Cancel: {
        auto it = calls_.find(ev.call);
        if (it == calls_.end())
            return fail("CAN for unknown call '" + ev.call + "'");
        if (it->second.state != CallState::Pending)
            return fail("CAN for call '" + ev.call + "' that is not pending");
        it->second.state = CallState::Cancelled;
        it->second.end_event = ev.index;
        return true;
    }
    }
    return fail("unhandled op");
}

std::vector<Edge> Model::wait_for_edges() const {
    std::map<std::string, std::vector<const Call*>> holders;
    for (const auto& [id, c] : calls_)
        if (c.state == CallState::Granted)
            holders[c.lock].push_back(&c);

    std::vector<Edge> edges;
    for (const auto& [id, c] : calls_) {
        if (c.state != CallState::Pending)
            continue;
        auto it = holders.find(c.lock);
        if (it == holders.end())
            continue;
        for (const Call* h : it->second) {
            if (h->thread == c.thread)
                continue; // a thread never blocks itself
            const bool blocks = c.mode == Mode::Exclusive ||
                                h->mode == Mode::Exclusive;
            if (!blocks)
                continue;
            Edge e;
            e.from = c.thread;
            e.to = h->thread;
            e.lock = c.lock;
            e.wait_mode = c.mode;
            e.hold_mode = h->mode;
            e.waiter_call = c.id;
            e.holder_call = h->id;
            e.waiter_req_event = c.req_event;
            e.holder_grant_event = h->grant_event;
            edges.push_back(std::move(e));
        }
    }
    return edges;
}

std::optional<Cycle> Model::shortest_cycle() const {
    // Collapse parallel edges between the same pair of threads, keeping the
    // earliest blocking request for deterministic reporting.
    std::map<std::string, std::map<std::string, Edge>> adj;
    std::set<std::string> nodes;
    for (const Edge& e : wait_for_edges()) {
        nodes.insert(e.from);
        nodes.insert(e.to);
        auto& slot = adj[e.from][e.to];
        if (slot.lock.empty() || e.waiter_req_event < slot.waiter_req_event)
            slot = e;
    }

    auto normalize = [](std::vector<std::string> cyc) {
        auto it = std::min_element(cyc.begin(), cyc.end());
        std::rotate(cyc.begin(), it, cyc.end());
        return cyc;
    };

    std::optional<std::vector<std::string>> best;
    for (const auto& start : nodes) {
        // BFS from `start`; the first depth at which an edge leads back to
        // `start` yields the shortest cycles through `start`.
        std::map<std::string, std::string> parent;
        std::map<std::string, std::size_t> depth{{start, 0}};
        std::deque<std::string> queue{start};
        std::optional<std::size_t> level_best;
        while (!queue.empty()) {
            std::string u = queue.front();
            queue.pop_front();
            if (level_best && depth[u] + 1 > *level_best)
                break; // only keep the minimal depth
            auto adj_it = adj.find(u);
            if (adj_it == adj.end())
                continue;
            for (const auto& [v, edge] : adj_it->second) {
                if (v == start) {
                    if (depth[u] + 1 < 2)
                        continue; // self loops are not emitted
                    std::vector<std::string> cyc{u};
                    for (std::string p = u; p != start; p = parent[p])
                        cyc.push_back(parent[p]);
                    std::reverse(cyc.begin(), cyc.end());
                    cyc = normalize(cyc);
                    if (!level_best || depth[u] + 1 < *level_best)
                        level_best = depth[u] + 1;
                    if (!best || cyc.size() < best->size() ||
                        (cyc.size() == best->size() && cyc < *best))
                        best = std::move(cyc);
                } else if (!depth.count(v)) {
                    depth[v] = depth[u] + 1;
                    parent[v] = u;
                    queue.push_back(v);
                }
            }
        }
    }

    if (!best)
        return std::nullopt;

    Cycle cycle;
    cycle.threads = *best;
    const std::size_t n = best->size();
    for (std::size_t i = 0; i < n; ++i)
        cycle.edges.push_back(adj.at((*best)[i]).at((*best)[(i + 1) % n]));
    return cycle;
}

Model Model::replay(const std::vector<Event>& events) {
    Model m;
    std::string err;
    for (const Event& ev : events)
        if (!m.apply(ev, err))
            throw std::logic_error("replay failed: " + err);
    return m;
}

bool Engine::apply(const Event& ev, std::string& err) {
    if (has_time_ && ev.time < last_time_) {
        err = "event #" + std::to_string(ev.index) +
              ": time goes backwards (log must be time-ordered)";
        return false;
    }
    has_time_ = true;
    last_time_ = ev.time;

    if (!model_.apply(ev, err))
        return false;
    history_.push_back(ev);

    if (verify_each_moment_) {
        Model fresh = Model::replay(history_);
        if (!model_.same_state(fresh)) {
            err = "event #" + std::to_string(ev.index) +
                  ": incremental model diverges from full replay";
            return false;
        }
        ++moments_verified_;
    }
    return true;
}

} // namespace lw
