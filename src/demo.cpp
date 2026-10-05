// 演示：惯性延迟取消、同 tick 输入优先、delta 轮、旧代事件失效
#include <iostream>
#include "gatesim.hpp"

using namespace gatesim;

static void scenario_inertial() {
    std::cout << "=== scenario 1: inertial delay (BUF d=2) ===\n";
    std::cout << "pulses: width 1 @t2 (cancelled), width 2 @t6 (passes, fires at t8 = falling edge),\n"
                 "        width 5 @t12 (passes)\n";
    Simulator sim;
    auto a = sim.add_node("a");
    auto n = sim.add_node("n");
    sim.add_gate("g1", GateKind::Buf, {a}, n, 2);
    sim.add_stimulus(2, a, Logic::L1);
    sim.add_stimulus(3, a, Logic::L0);
    sim.add_stimulus(6, a, Logic::L1);
    sim.add_stimulus(8, a, Logic::L0);
    sim.add_stimulus(12, a, Logic::L1);
    sim.add_stimulus(17, a, Logic::L0);
    sim.run(22);
    std::cout << format_waveform(sim) << format_records(sim) << '\n';
}

static void scenario_delta_chain() {
    std::cout << "=== scenario 2: zero-delay delta chain (3 x NOT d=0) ===\n";
    Simulator sim;
    auto a = sim.add_node("a");
    auto n1 = sim.add_node("n1", Logic::L1);
    auto n2 = sim.add_node("n2", Logic::L0);
    auto n3 = sim.add_node("n3", Logic::L1);
    sim.add_gate("g1", GateKind::Not, {a}, n1, 0);
    sim.add_gate("g2", GateKind::Not, {n1}, n2, 0);
    sim.add_gate("g3", GateKind::Not, {n2}, n3, 0);
    sim.add_stimulus(3, a, Logic::L1);
    sim.run(8);
    std::cout << format_waveform(sim) << format_records(sim) << '\n';
}

static void scenario_xor_glitch() {
    std::cout << "=== scenario 3: two delays + zero-delay XOR (glitch) ===\n";
    Simulator sim;
    auto a = sim.add_node("a");
    auto n1 = sim.add_node("n1");
    auto n2 = sim.add_node("n2");
    auto out = sim.add_node("out");
    sim.add_gate("d1", GateKind::Buf, {a}, n1, 1);
    sim.add_gate("d3", GateKind::Buf, {a}, n2, 3);
    sim.add_gate("xr", GateKind::Xor, {n1, n2}, out, 0);
    sim.add_stimulus(2, a, Logic::L1);
    sim.add_stimulus(6, a, Logic::L0);
    sim.run(12);
    std::cout << format_waveform(sim) << format_records(sim) << '\n';
}

static void scenario_oscillator() {
    std::cout << "=== scenario 4: two NOT d=1 in a loop (period-2 oscillator) ===\n";
    Simulator sim;
    auto n1 = sim.add_node("n1");
    auto n2 = sim.add_node("n2");
    sim.add_gate("g1", GateKind::Not, {n2}, n1, 1);
    sim.add_gate("g2", GateKind::Not, {n1}, n2, 1);
    sim.run(10);
    std::cout << format_waveform(sim) << format_records(sim) << '\n';
}

int main() {
    scenario_inertial();
    scenario_delta_chain();
    scenario_xor_glitch();
    scenario_oscillator();
    return 0;
}
