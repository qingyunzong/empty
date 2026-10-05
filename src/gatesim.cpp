#include "gatesim.hpp"

#include <algorithm>
#include <iomanip>
#include <sstream>
#include <stdexcept>

namespace gatesim {

char to_char(Logic v) { return v == Logic::L1 ? '1' : '0'; }

Logic eval_gate(GateKind kind, const std::vector<Logic>& in) {
    auto bit = [](Logic v) { return v == Logic::L1; };
    auto mk = [](bool b) { return b ? Logic::L1 : Logic::L0; };
    switch (kind) {
        case GateKind::Buf: return in.at(0);
        case GateKind::Not: return mk(!bit(in.at(0)));
        case GateKind::And:
            for (Logic v : in)
                if (!bit(v)) return Logic::L0;
            return Logic::L1;
        case GateKind::Or:
            for (Logic v : in)
                if (bit(v)) return Logic::L1;
            return Logic::L0;
        case GateKind::Nand: return mk(!bit(eval_gate(GateKind::And, in)));
        case GateKind::Nor: return mk(!bit(eval_gate(GateKind::Or, in)));
        case GateKind::Xor: {
            bool x = false;
            for (Logic v : in) x = x != bit(v);
            return mk(x);
        }
    }
    return Logic::L0;
}

std::size_t Simulator::add_node(std::string name, Logic init) {
    node_names_.push_back(std::move(name));
    node_values_.push_back(init);
    fanout_.emplace_back();
    driver_of_.push_back(-1);
    return node_names_.size() - 1;
}

std::size_t Simulator::add_gate(std::string name, GateKind kind,
                                std::vector<std::size_t> inputs,
                                std::size_t output, int delay) {
    if (delay < 0) throw std::invalid_argument("gate delay must be >= 0");
    if (output >= node_names_.size()) throw std::invalid_argument("bad output node");
    for (std::size_t i : inputs)
        if (i >= node_names_.size()) throw std::invalid_argument("bad input node");
    const bool unary = (kind == GateKind::Buf || kind == GateKind::Not);
    if (unary && inputs.size() != 1)
        throw std::invalid_argument("unary gate needs exactly 1 input");
    if (!unary && inputs.empty())
        throw std::invalid_argument("gate needs at least 1 input");
    if (driver_of_[output] >= 0)
        throw std::invalid_argument("node already driven by another gate");

    const std::size_t gi = gates_.size();
    gates_.push_back(Gate{std::move(name), kind, std::move(inputs), output, delay, 0, std::nullopt});
    driver_of_[output] = static_cast<int>(gi);
    for (std::size_t i : gates_[gi].inputs) fanout_[i].push_back(gi);
    in_zero_work_.push_back(0);
    in_touched_.push_back(0);
    return gi;
}

void Simulator::add_stimulus(std::uint64_t time, std::size_t node, Logic value) {
    if (node >= node_names_.size()) throw std::invalid_argument("bad stimulus node");
    stimuli_[time].emplace_back(node, value);
}

Logic Simulator::desired(const Gate& g) const {
    std::vector<Logic> ins;
    ins.reserve(g.inputs.size());
    for (std::size_t i : g.inputs) ins.push_back(node_values_[i]);
    return eval_gate(g.kind, ins);
}

void Simulator::set_node(std::size_t n, Logic v, std::uint64_t t, std::string reason) {
    if (node_values_[n] == v) return;
    const Logic old = node_values_[n];
    node_values_[n] = v;
    changes_.push_back(ChangeRecord{t, current_delta_, n, old, v, std::move(reason)});
    for (std::size_t g : fanout_[n]) {
        if (gates_[g].delay == 0) {
            if (!in_zero_work_[g]) {
                in_zero_work_[g] = 1;
                zero_work_.push_back(g);
            }
        } else {
            if (!in_touched_[g]) {
                in_touched_[g] = 1;
                touched_.push_back(g);
            }
        }
    }
}

void Simulator::settle_delta(std::uint64_t t) {
    while (!zero_work_.empty()) {
        // 原子轮：先用轮初的值计算所有期望输出，再统一下发
        std::vector<std::pair<std::size_t, Logic>> outs;
        for (std::size_t g : zero_work_) {
            in_zero_work_[g] = 0;
            Logic d = desired(gates_[g]);
            if (d != node_values_[gates_[g].output]) outs.emplace_back(g, d);
        }
        zero_work_.clear();
        if (outs.empty()) break;
        ++current_delta_;
        for (const auto& [g, d] : outs) {
            set_node(gates_[g].output, d, t,
                     "zero-delay gate '" + gates_[g].name + "' (delta round " +
                         std::to_string(current_delta_) + ")");
        }
    }
}

void Simulator::reconcile(std::size_t gi, std::uint64_t t) {
    Gate& g = gates_[gi];
    const Logic d = desired(g);
    const Logic cur = node_values_[g.output];
    if (d == cur) {
        if (g.pending) {
            const std::uint64_t sched_at = g.pending->fire_time - static_cast<std::uint64_t>(g.delay);
            cancels_.push_back(CancelRecord{
                t, gi, g.pending->value, g.pending->fire_time,
                "inertial cancel: input reverted after " + std::to_string(t - sched_at) +
                    " tick(s) < delay " + std::to_string(g.delay)});
            g.pending.reset();
            ++g.gen;  // 旧代事件失效
        }
        return;
    }
    if (g.pending && g.pending->value == d) return;  // 已调度同值事件
    if (g.pending) {
        cancels_.push_back(CancelRecord{t, gi, g.pending->value, g.pending->fire_time,
                                        "superseded by newer event (old generation invalidated)"});
        g.pending.reset();
        ++g.gen;
    }
    ++g.gen;
    g.pending = Gate::Pending{t + static_cast<std::uint64_t>(g.delay), d, g.gen};
    queue_heap_.push_back(QueuedEvent{g.pending->fire_time, next_seq_++, gi, g.gen, d});
    std::push_heap(queue_heap_.begin(), queue_heap_.end(),
                   [](const QueuedEvent& x, const QueuedEvent& y) {
                       if (x.time != y.time) return x.time > y.time;
                       return x.seq > y.seq;
                   });
}

void Simulator::run(std::uint64_t ticks) {
    auto queue_top_time = [&]() -> std::uint64_t { return queue_heap_.front().time; };
    auto queue_pop = [&]() -> QueuedEvent {
        std::pop_heap(queue_heap_.begin(), queue_heap_.end(),
                      [](const QueuedEvent& x, const QueuedEvent& y) {
                          if (x.time != y.time) return x.time > y.time;
                          return x.seq > y.seq;
                      });
        QueuedEvent e = queue_heap_.back();
        queue_heap_.pop_back();
        return e;
    };

    // t=0 初始化：所有门求值一次
    for (std::size_t gi = 0; gi < gates_.size(); ++gi) {
        if (gates_[gi].delay == 0) {
            in_zero_work_[gi] = 1;
            zero_work_.push_back(gi);
        } else {
            in_touched_[gi] = 1;
            touched_.push_back(gi);
        }
    }
    settle_delta(0);
    for (std::size_t gi : touched_) {
        in_touched_[gi] = 0;
        reconcile(gi, 0);
    }
    touched_.clear();

    for (std::uint64_t t = 0; t < ticks; ++t) {
        current_delta_ = 0;
        // 阶段 1：外部输入先施加
        auto it = stimuli_.find(t);
        if (it != stimuli_.end())
            for (const auto& [n, v] : it->second) set_node(n, v, t, "stimulus");
        settle_delta(t);
        // 阶段 2：到期事件触发（旧代事件跳过）
        while (!queue_heap_.empty() && queue_top_time() == t) {
            QueuedEvent e = queue_pop();
            Gate& g = gates_[e.gate];
            if (!g.pending || g.pending->gen != e.gen) {
                stale_.push_back(StaleRecord{
                    t, e.gate, e.gen, g.gen,
                    "stale event skipped: old generation never takes effect"});
                continue;
            }
            g.pending.reset();
            set_node(g.output, e.value, t,
                     "gate '" + g.name + "' event fires (delay " + std::to_string(g.delay) +
                         ", gen " + std::to_string(e.gen) + ")");
            settle_delta(t);
        }
        // 阶段 3：输入变化过的延迟门重调度
        for (std::size_t gi : touched_) {
            in_touched_[gi] = 0;
            reconcile(gi, t);
        }
        touched_.clear();
        // 快照
        snapshots_.push_back(node_values_);
    }
}

std::string format_waveform(const Simulator& sim) {
    const auto& snaps = sim.snapshots();
    const auto& names = sim.node_names();
    std::ostringstream os;
    std::size_t width = 1;
    for (const auto& n : names) width = std::max(width, n.size());
    os << std::string(width + 1, ' ');
    for (std::size_t t = 0; t < snaps.size(); ++t)
        os << ' ' << (t >= 10 ? static_cast<char>('0' + (t / 10) % 10) : ' ');
    os << '\n';
    os << std::string(width + 1, ' ');
    for (std::size_t t = 0; t < snaps.size(); ++t)
        os << ' ' << static_cast<char>('0' + t % 10);
    os << '\n';
    for (std::size_t n = 0; n < names.size(); ++n) {
        os << std::setw(static_cast<int>(width)) << names[n] << ' ';
        for (std::size_t t = 0; t < snaps.size(); ++t) os << std::setw(2) << to_char(snaps[t][n]);
        os << '\n';
    }
    return os.str();
}

std::string format_records(const Simulator& sim) {
    std::ostringstream os;
    os << "value changes (time, delta, node, old->new, reason):\n";
    for (const auto& c : sim.changes())
        os << "  t=" << c.time << " d" << c.delta << " " << sim.node_names()[c.node] << " "
           << to_char(c.old_value) << "->" << to_char(c.new_value) << "  [" << c.reason << "]\n";
    os << "cancelled events (inertial):\n";
    for (const auto& c : sim.cancels())
        os << "  t=" << c.time << " gate=" << sim.gate_name(c.gate)
           << " value=" << to_char(c.cancelled_value) << " was_fire_time=" << c.was_fire_time
           << "  [" << c.reason << "]\n";
    os << "stale events skipped (old generation):\n";
    for (const auto& s : sim.stale_events())
        os << "  t=" << s.time << " gate=" << sim.gate_name(s.gate) << " gen=" << s.event_gen
           << " current_gen=" << s.current_gen << "  [" << s.reason << "]\n";
    return os.str();
}

}  // namespace gatesim
