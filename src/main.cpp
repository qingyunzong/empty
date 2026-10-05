#include <iostream>
#include "gatesim.hpp"

using namespace gatesim;

static void print_log(const Simulator& sim) {
    std::cout << "事件日志（原因）:\n";
    for (const auto& line : sim.log()) std::cout << "  " << line << "\n";
}

static void scenario_inertial() {
    std::cout << "=== 场景 A：惯性延迟取消窄脉冲，旧代事件失效 ===\n";
    std::cout << "NOT 门 d=3；in 在 t=2..4 有宽度 2 的窄脉冲（<3，应被取消），"
                 "t=8..14 有宽度 6 的脉冲（>=3，应通过）\n";
    Simulator sim;
    auto in  = sim.add_signal("in",  Logic::Low);
    auto out = sim.add_signal("out", Logic::High);
    sim.add_gate(GateKind::Not, {in}, out, 3);
    sim.set_input(in, 2,  Logic::High);
    sim.set_input(in, 4,  Logic::Low);
    sim.set_input(in, 8,  Logic::High);
    sim.set_input(in, 14, Logic::Low);
    sim.run();
    std::cout << sim.waveform_text(in);
    std::cout << sim.waveform_text(out);
    print_log(sim);
    std::cout << "\n";
}

static void scenario_delta() {
    std::cout << "=== 场景 B：零延迟门用 delta 轮逐级传播 ===\n";
    std::cout << "in -> NOT(d=0) -> m -> NOT(d=0) -> out；in 在 t=2 变 1，"
                 "m 应在 t=2 δ1 变 0，out 应在 t=2 δ2 变 1\n";
    Simulator sim;
    auto in  = sim.add_signal("in",  Logic::Low);
    auto m   = sim.add_signal("m",   Logic::High);
    auto out = sim.add_signal("out", Logic::Low);
    sim.add_gate(GateKind::Not, {in}, m, 0);
    sim.add_gate(GateKind::Not, {m}, out, 0);
    sim.set_input(in, 2, Logic::High);
    sim.run();
    std::cout << sim.waveform_text(in);
    std::cout << sim.waveform_text(m);
    std::cout << sim.waveform_text(out);
    print_log(sim);
    std::cout << "\n";
}

static void scenario_same_tick() {
    std::cout << "=== 场景 C：同 tick 先输入（激励+到期事件）后门更新 ===\n";
    std::cout << "AND 门 d=2；a、b 在 t=1 同变 1（调度 out->1 @t=3），"
                 "a 在 t=3 变 0（与到期事件同 tick，先施加再求值，out 随后于 t=5 回落）\n";
    Simulator sim;
    auto a   = sim.add_signal("a",   Logic::Low);
    auto b   = sim.add_signal("b",   Logic::Low);
    auto out = sim.add_signal("out", Logic::Low);
    sim.add_gate(GateKind::And, {a, b}, out, 2);
    sim.set_input(a, 1, Logic::High);
    sim.set_input(b, 1, Logic::High);
    sim.set_input(a, 3, Logic::Low);
    sim.run();
    std::cout << sim.waveform_text(a);
    std::cout << sim.waveform_text(out);
    print_log(sim);
    std::cout << "\n";
}

int main() {
    scenario_inertial();
    scenario_delta();
    scenario_same_tick();
    return 0;
}
