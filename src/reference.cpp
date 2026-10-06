#include "reference.hpp"

#include <algorithm>
#include <stdexcept>

namespace netsim {

int ReferenceSimulator::add_link(std::uint64_t bytes_per_tick) {
    bandwidth_.push_back(bytes_per_tick);
    return static_cast<int>(bandwidth_.size()) - 1;
}

void ReferenceSimulator::add_flow(int flow_id, std::vector<int> path, std::uint64_t size, Tick at_tick) {
    if (path.empty()) {
        throw std::invalid_argument("flow path must not be empty");
    }
    auto it = std::lower_bound(flows_.begin(), flows_.end(), flow_id,
                               [](const RefFlow& f, int id) { return f.id < id; });
    if (it != flows_.end() && it->id == flow_id) {
        throw std::invalid_argument("duplicate flow id");
    }
    RefFlow f;
    f.id = flow_id;
    f.path = std::move(path);
    f.size = size;
    f.added_tick = at_tick;
    f.ready.resize(f.path.size());
    f.arriving.resize(f.path.size());
    for (std::uint64_t b = 0; b < size; ++b) {
        f.ready[0].push_back(b);
    }
    flows_.insert(it, std::move(f));
}

void ReferenceSimulator::cancel_flow(int flow_id, Tick at_tick) {
    auto it = std::lower_bound(flows_.begin(), flows_.end(), flow_id,
                               [](const RefFlow& f, int id) { return f.id < id; });
    if (it == flows_.end() || it->id != flow_id) {
        throw std::invalid_argument("cancel of unknown flow");
    }
    it->has_cancel = true;
    it->cancel_tick = at_tick;
}

std::vector<ByteEvent> ReferenceSimulator::run(Tick max_ticks) {
    std::vector<ByteEvent> events;
    auto done = [&] {
        return std::all_of(flows_.begin(), flows_.end(), [](const RefFlow& f) {
            return f.delivered + f.cancelled == f.size;
        });
    };
    for (Tick tick = 0; tick < max_ticks && !done(); ++tick) {
        // Arrivals from last tick become sendable.
        for (RefFlow& f : flows_) {
            for (std::size_t h = 0; h < f.path.size(); ++h) {
                while (!f.arriving[h].empty()) {
                    f.ready[h].push_back(f.arriving[h].front());
                    f.arriving[h].pop_front();
                }
            }
        }
        // Cancellations revoke only never-sent bytes.
        for (RefFlow& f : flows_) {
            if (f.has_cancel && !f.cancel_applied && f.cancel_tick <= tick) {
                f.cancelled += f.ready[0].size();
                f.ready[0].clear();
                f.cancel_applied = true;
            }
        }
        // Per-link round-robin, one byte per turn, ascending flow id.
        for (int link_id = 0; link_id < static_cast<int>(bandwidth_.size()); ++link_id) {
            std::uint64_t budget = bandwidth_[link_id];
            while (budget > 0) {
                bool progress = false;
                for (RefFlow& f : flows_) {
                    if (budget == 0) break;
                    if (f.delivered + f.cancelled == f.size) continue;
                    if (f.added_tick >= tick) continue;
                    for (std::size_t h = 0; h < f.path.size(); ++h) {
                        if (f.path[h] == link_id && !f.ready[h].empty()) {
                            const std::uint64_t byte_index = f.ready[h].front();
                            f.ready[h].pop_front();
                            events.push_back(ByteEvent{tick, f.id, link_id, byte_index});
                            --budget;
                            progress = true;
                            if (h + 1 == f.path.size()) {
                                ++f.delivered;
                            } else {
                                f.arriving[h + 1].push_back(byte_index);
                            }
                            break;
                        }
                    }
                }
                if (!progress) break;
            }
        }
    }
    return events;
}

std::vector<ReferenceSimulator::FlowResult> ReferenceSimulator::results() const {
    std::vector<FlowResult> out;
    out.reserve(flows_.size());
    for (const RefFlow& f : flows_) {
        out.push_back(FlowResult{f.id, f.size, f.delivered, f.cancelled});
    }
    return out;
}

}  // namespace netsim
