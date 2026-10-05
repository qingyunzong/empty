#include "gatesim.hpp"

#include <algorithm>
#include <sstream>
#include <stdexcept>

namespace gatesim {

const char* to_string(GateKind kind) {
    switch (kind) {
        case GateKind::Not:  return "NOT";
        case GateKind::And:  return "AND";
        case GateKind::Or:   return "OR";
        case GateKind::Xor:  return "XOR";
        case GateKind::Nand: return "NAND";
        case GateKind::Nor:  return "NOR";
    }
    return "?";
}

char to_char(Logic v) { return v == Logic::High ? '1' : '0'; }

std::size_t Simulator::add_signal(std::string name, Logic init) {
    signals_.push_back(Signal{std::move(name), init, {}});
    signals_.back().history.push_back(Change{0, 0, init, "初始值"});
    return signals_.size() - 1;
}

std::size_t Simulator::add_gate(GateKind kind, std::vector<std::size_t> inputs,
                                std::size_t output, std::uint64_t delay) {
    gates_.push_back(Gate{kind, std::move(inputs), output, delay, 0, false});
    return gates_.size() - 1;
}

void Simulator::set_input(std::size_t sig, std::uint64_t time, Logic value) {
    stimulus_[time].emplace_back(sig, value);
}

std::string Simulator::gate_name(std::size_t gi) const {
    const Gate& g = gates_[gi];
    return std::string(to_string(g.kind)) + "#" + std::to_string(gi) +
           "(d=" + std::to_string(g.delay) + ")";
}

Logic Simulator::eval(const Gate& g) const {
    auto val = [&](std::size_t s) { return signals_.at(s).value; };
    auto fold = [&](Logic start, auto op) {
        Logic acc = start;
        for (std::size_t in : g.inputs) acc = op(acc, val(in));
        return acc;
    };
    auto lnot = [](Logic a) { return a == Logic::Low ? Logic::High : Logic::Low; };
    auto land = [](Logic a, Logic b) { return a == Logic::High && b == Logic::High ? Logic::High : Logic::Low; };
    auto lor  = [](Logic a, Logic b) { return a == Logic::High || b == Logic::High ? Logic::High : Logic::Low; };
    auto lxor = [](Logic a, Logic b) { return a != b ? Logic::High : Logic::Low; };
    switch (g.kind) {
        case GateKind::Not:  return lnot(val(g.inputs[0]));
        case GateKind::And:  return fold(Logic::High, land);
        case GateKind::Or:   return fold(Logic::Low, lor);
        case GateKind::Xor:  return fold(Logic::Low, lxor);
        case GateKind::Nand: return lnot(fold(Logic::High, land));
        case GateKind::Nor:  return lnot(fold(Logic::Low, lor));
    }
    return Logic::Low;
}

void Simulator::apply_change(std::size_t sig, Logic v, std::uint32_t delta,
                             std::string reason, std::vector<bool>& dirty) {
    Signal& s = signals_.at(sig);
    if (s.value == v) return;
    s.value = v;
    s.history.push_back(Change{now_, delta, v, std::move(reason)});
    for (std::size_t gi = 0; gi < gates_.size(); ++gi) {
        const Gate& g = gates_[gi];
        if (std::find(g.inputs.begin(), g.inputs.end(), sig) != g.inputs.end())
            dirty[gi] = true;
    }
}

void Simulator::update_inertial(std::size_t gi, Logic v) {
    Gate& g = gates_[gi];
    const Signal& out = signals_.at(g.output);
    const std::string t = std::to_string(now_);
    if (v == out.value) {
        if (g.has_pending) {
            g.has_pending = false;
            ++g.token;
            log_.push_back("t=" + t + " " + gate_name(gi) + "：撤销未到期事件（惯性延迟 d=" +
                           std::to_string(g.delay) + "，窄脉冲被取消），" + out.name +
                           " 保持 " + to_char(out.value));
        }
    } else if (!g.has_pending) {
        g.has_pending = true;
        ++g.token;
        events_[now_ + g.delay].push_back(Event{gi, g.token, v});
        log_.push_back("t=" + t + " " + gate_name(gi) + "：调度 " + out.name + " -> " +
                       to_char(v) + " @t=" + std::to_string(now_ + g.delay));
    } else {
        log_.push_back("t=" + t + " " + gate_name(gi) + "：目标值同既有未到期事件，不延长调度");
    }
}

void Simulator::settle(std::vector<bool>& dirty) {
    struct Deferred { std::size_t sig; Logic v; std::string reason; };
    std::uint32_t delta = 0;
    while (true) {
        std::vector<Deferred> deferred;
        for (std::size_t gi = 0; gi < gates_.size(); ++gi) {
            if (!dirty[gi]) continue;
            dirty[gi] = false;
            const Gate& g = gates_[gi];
            Logic v = eval(g);
            if (g.delay == 0) {
                if (v != signals_.at(g.output).value)
                    deferred.push_back({g.output, v, gate_name(gi) + " 零延迟 delta 更新"});
            } else {
                update_inertial(gi, v);
            }
        }
        if (deferred.empty()) break;
        ++delta;
        if (delta > max_delta)
            throw std::runtime_error("零延迟组合环路在 delta 轮内不收敛");
        for (auto& d : deferred)
            apply_change(d.sig, d.v, delta, std::move(d.reason), dirty);
    }
}

void Simulator::run() {
    std::vector<bool> dirty(gates_.size(), true);
    now_ = 0;
    settle(dirty);
    while (!events_.empty() || !stimulus_.empty()) {
        std::uint64_t t = ~std::uint64_t{0};
        if (!events_.empty()) t = std::min(t, events_.begin()->first);
        if (!stimulus_.empty()) t = std::min(t, stimulus_.begin()->first);
        now_ = t;
        if (auto it = stimulus_.find(t); it != stimulus_.end()) {
            for (auto& [sig, v] : it->second)
                apply_change(sig, v, 0, "外部激励", dirty);
            stimulus_.erase(it);
        }
        if (auto it = events_.find(t); it != events_.end()) {
            for (auto& ev : it->second) {
                Gate& g = gates_[ev.gate];
                if (!g.has_pending || ev.token != g.token) {
                    log_.push_back("t=" + std::to_string(t) + " " + gate_name(ev.gate) +
                                   "：丢弃过期事件（旧代延迟事件不生效）");
                    continue;
                }
                g.has_pending = false;
                apply_change(g.output, ev.value, 0,
                             gate_name(ev.gate) + " 惯性延迟事件到期", dirty);
            }
            events_.erase(it);
        }
        settle(dirty);
    }
}

Logic Simulator::value_at(std::size_t sig, std::uint64_t time) const {
    const Signal& s = signals_.at(sig);
    Logic v = s.history.front().value;
    for (const Change& c : s.history) {
        if (c.time > time) break;
        v = c.value;
    }
    return v;
}

std::string Simulator::waveform_text(std::size_t sig) const {
    const Signal& s = signals_.at(sig);
    std::uint64_t tmax = 0;
    for (const Change& c : s.history) tmax = std::max(tmax, c.time);
    std::ostringstream os;
    os << "信号 " << s.name << ":\n";
    for (const Change& c : s.history)
        os << "  t=" << c.time << " δ" << c.delta << " -> " << to_char(c.value)
           << "  (" << c.reason << ")\n";
    os << "  逐 tick 电平: ";
    for (std::uint64_t t = 0; t <= tmax; ++t) os << to_char(value_at(sig, t));
    os << "\n  tick 序号:    ";
    for (std::uint64_t t = 0; t <= tmax; ++t) os << (t % 10);
    os << "\n";
    return os.str();
}

} // namespace gatesim
