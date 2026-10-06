#include "simulator.hpp"

#include <algorithm>
#include <stdexcept>

namespace netsim {

int Simulator::add_link(std::uint64_t bytes_per_tick) {
    links_.push_back(Link{bytes_per_tick});
    return static_cast<int>(links_.size()) - 1;
}

void Simulator::add_flow(int flow_id, std::vector<int> path, std::uint64_t size, Tick at_tick) {
    if (path.empty()) {
        throw std::invalid_argument("flow path must not be empty");
    }
    for (int link : path) {
        if (link < 0 || link >= static_cast<int>(links_.size())) {
            throw std::invalid_argument("flow path references unknown link");
        }
    }
    auto it = std::lower_bound(flows_.begin(), flows_.end(), flow_id,
                               [](const FlowState& f, int id) { return f.id < id; });
    if (it != flows_.end() && it->id == flow_id) {
        throw std::invalid_argument("duplicate flow id");
    }
    FlowState f;
    f.id = flow_id;
    f.path = std::move(path);
    f.size = size;
    f.added_tick = at_tick;
    f.pending.assign(f.path.size(), 0);
    f.arriving.assign(f.path.size(), 0);
    f.sent_on_hop.assign(f.path.size(), 0);
    f.pending[0] = size;  // all bytes start unsent at the source
    flows_.insert(it, std::move(f));
}

void Simulator::cancel_flow(int flow_id, Tick at_tick) {
    auto it = std::lower_bound(flows_.begin(), flows_.end(), flow_id,
                               [](const FlowState& f, int id) { return f.id < id; });
    if (it == flows_.end() || it->id != flow_id) {
        throw std::invalid_argument("cancel of unknown flow");
    }
    it->has_cancel = true;
    it->cancel_tick = at_tick;
}

void Simulator::run(Tick num_ticks) {
    for (Tick i = 0; i < num_ticks && !finished(); ++i) {
        step();
        ++now_;
    }
}

bool Simulator::finished() const {
    return std::all_of(flows_.begin(), flows_.end(), [](const FlowState& f) { return f.completed; });
}

void Simulator::step() {
    const Tick tick = now_;

    // 1. Bytes that crossed a link last tick become sendable on the next hop.
    for (FlowState& f : flows_) {
        for (std::size_t h = 0; h < f.path.size(); ++h) {
            f.pending[h] += f.arriving[h];
            f.arriving[h] = 0;
        }
    }

    // 2. Cancellations: revoke only bytes that were never sent (still at source).
    for (FlowState& f : flows_) {
        if (f.has_cancel && !f.cancel_applied && f.cancel_tick <= tick) {
            f.cancelled += f.pending[0];
            f.pending[0] = 0;
            f.cancel_applied = true;
        }
    }
    update_completion();

    // 3. Per-link allocation: round-robin by ascending flow id, one byte per turn.
    for (int link_id = 0; link_id < static_cast<int>(links_.size()); ++link_id) {
        std::uint64_t budget = links_[link_id].bandwidth;
        while (budget > 0) {
            bool progress = false;
            for (FlowState& f : flows_) {
                if (budget == 0) break;
                if (f.completed || f.added_tick >= tick) continue;  // joins the round after its add tick
                for (std::size_t h = 0; h < f.path.size(); ++h) {
                    if (f.path[h] == link_id && f.pending[h] > 0) {
                        --f.pending[h];
                        const std::uint64_t byte_index = f.sent_on_hop[h]++;
                        events_.push_back(ByteEvent{tick, f.id, link_id, byte_index});
                        --budget;
                        progress = true;
                        if (h + 1 == f.path.size()) {
                            ++f.delivered;
                        } else {
                            ++f.arriving[h + 1];
                        }
                        break;
                    }
                }
            }
            if (!progress) break;
        }
    }

    update_completion();
}

void Simulator::update_completion() {
    for (FlowState& f : flows_) {
        if (!f.completed && f.delivered + f.cancelled == f.size) {
            f.completed = true;
            f.completion_tick = now_;
        }
    }
}

std::vector<FlowAccounting> Simulator::accounting() const {
    std::vector<FlowAccounting> out;
    out.reserve(flows_.size());
    for (const FlowState& f : flows_) {
        FlowAccounting a;
        a.flow_id = f.id;
        a.size = f.size;
        a.delivered = f.delivered;
        a.cancelled = f.cancelled;
        a.unsent = f.pending[0];
        for (std::size_t h = 1; h < f.path.size(); ++h) {
            a.in_flight += f.pending[h] + f.arriving[h];
        }
        a.completed = f.completed;
        a.completion_tick = f.completion_tick;
        out.push_back(a);
    }
    return out;
}

bool Simulator::check_conservation(std::string& error) const {
    for (const FlowState& f : flows_) {
        std::uint64_t total = f.delivered + f.cancelled;
        for (std::size_t h = 0; h < f.path.size(); ++h) {
            total += f.pending[h] + f.arriving[h];
        }
        if (total != f.size) {
            error = "flow " + std::to_string(f.id) + ": accounted " + std::to_string(total) +
                    " bytes but size is " + std::to_string(f.size);
            return false;
        }
    }
    return true;
}

}  // namespace netsim
