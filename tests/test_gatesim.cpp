#include <cstdint>
#include <iostream>
#include <string>
#include <vector>
#include "gatesim.hpp"

using namespace gatesim;

static int failures = 0;

static void fail(const std::string& msg) {
    ++failures;
    std::cout << "  FAIL: " << msg << "\n";
}

struct Exp {
    std::uint64_t t;
    std::uint32_t d;
    char v;
};

static void check_history(const Simulator& sim, std::size_t sig,
                          const std::vector<Exp>& exp, const std::string& what) {
    const auto& h = sim.signal(sig).history;
    if (h.size() != exp.size()) {
        fail(what + ": 历史长度 " + std::to_string(h.size()) + " != 期望 " +
             std::to_string(exp.size()));
    }
    for (std::size_t i = 0; i < h.size() && i < exp.size(); ++i) {
        if (h[i].time != exp[i].t || h[i].delta != exp[i].d ||
            to_char(h[i].value) != exp[i].v) {
            fail(what + " [" + std::to_string(i) + "]: 实际(t=" +
                 std::to_string(h[i].time) + ",δ" + std::to_string(h[i].delta) + "," +
                 to_char(h[i].value) + ") 期望(t=" + std::to_string(exp[i].t) + ",δ" +
                 std::to_string(exp[i].d) + "," + exp[i].v + ")");
        }
    }
}

static void check_ticks(const Simulator& sim, std::size_t sig,
                        const std::string& expect, const std::string& what) {
    for (std::uint64_t t = 0; t < expect.size(); ++t) {
        if (to_char(sim.value_at(sig, t)) != expect[t]) {
            fail(what + ": t=" + std::to_string(t) + " 电平 " +
                 to_char(sim.value_at(sig, t)) + " != 期望 " + expect[t]);
        }
    }
}

static void check_log_contains(const Simulator& sim, const std::string& needle) {
    for (const auto& line : sim.log())
        if (line.find(needle) != std::string::npos) return;
    fail("日志缺少: " + needle);
}

static void check_reason_at(const Simulator& sim, std::size_t sig, std::size_t idx,
                            const std::string& needle, const std::string& what) {
    const auto& h = sim.signal(sig).history;
    if (idx >= h.size() || h[idx].reason.find(needle) == std::string::npos)
        fail(what + ": 历史[" + std::to_string(idx) + "] 原因不含 \"" + needle + "\"");
}

// NOT d=3：宽度 2 的窄脉冲被取消且旧代事件失效；宽度 6 的脉冲通过
static int test_inertial_cancel() {
    Simulator sim;
    auto in  = sim.add_signal("in",  Logic::Low);
    auto out = sim.add_signal("out", Logic::High);
    sim.add_gate(GateKind::Not, {in}, out, 3);
    sim.set_input(in, 2,  Logic::High);
    sim.set_input(in, 4,  Logic::Low);
    sim.set_input(in, 8,  Logic::High);
    sim.set_input(in, 14, Logic::Low);
    sim.run();
    check_history(sim, out, {{0,0,'1'},{11,0,'0'},{17,0,'1'}}, "inertial out");
    check_ticks(sim, out, "111111111110000001", "inertial out 逐tick");
    check_log_contains(sim, "撤销未到期事件");
    check_log_contains(sim, "丢弃过期事件");
    return failures;
}

// AND d=4：b 的窄脉冲使调度事件先被撤销、后作为旧代事件被丢弃，out 恒 0
static int test_stale_event() {
    Simulator sim;
    auto a   = sim.add_signal("a",   Logic::Low);
    auto b   = sim.add_signal("b",   Logic::Low);
    auto out = sim.add_signal("out", Logic::Low);
    sim.add_gate(GateKind::And, {a, b}, out, 4);
    sim.set_input(a, 1, Logic::High);
    sim.set_input(b, 2, Logic::High);
    sim.set_input(b, 4, Logic::Low);
    sim.run();
    check_history(sim, out, {{0,0,'0'}}, "stale out");
    check_ticks(sim, out, "00000000", "stale out 逐tick");
    check_log_contains(sim, "撤销未到期事件");
    check_log_contains(sim, "丢弃过期事件");
    return failures;
}

// 两级 NOT(d=0)：t=2 输入翻转，m 于 δ1、out 于 δ2 跟随，同 tick 内收敛
static int test_zero_delay_delta() {
    Simulator sim;
    auto in  = sim.add_signal("in",  Logic::Low);
    auto m   = sim.add_signal("m",   Logic::High);
    auto out = sim.add_signal("out", Logic::Low);
    sim.add_gate(GateKind::Not, {in}, m, 0);
    sim.add_gate(GateKind::Not, {m}, out, 0);
    sim.set_input(in, 2, Logic::High);
    sim.run();
    check_history(sim, m,   {{0,0,'1'},{2,1,'0'}}, "delta m");
    check_history(sim, out, {{0,0,'0'},{2,2,'1'}}, "delta out");
    check_reason_at(sim, out, 1, "零延迟 delta 更新", "delta out 原因");
    check_ticks(sim, out, "001", "delta out 逐tick");
    return failures;
}

// 同 tick 先输入后门更新：t=3 激励 a->0 与事件 out->1 同相施加后再求值
static int test_same_tick_order() {
    Simulator sim;
    auto a   = sim.add_signal("a",   Logic::Low);
    auto b   = sim.add_signal("b",   Logic::Low);
    auto out = sim.add_signal("out", Logic::Low);
    sim.add_gate(GateKind::And, {a, b}, out, 2);
    sim.set_input(a, 1, Logic::High);
    sim.set_input(b, 1, Logic::High);
    sim.set_input(a, 3, Logic::Low);
    sim.run();
    check_history(sim, a,   {{0,0,'0'},{1,0,'1'},{3,0,'0'}}, "tick a");
    check_history(sim, out, {{0,0,'0'},{3,0,'1'},{5,0,'0'}}, "tick out");
    check_reason_at(sim, a,   2, "外部激励", "tick a 原因");
    check_reason_at(sim, out, 1, "惯性延迟事件到期", "tick out 原因");
    check_ticks(sim, out, "000110", "tick out 逐tick");
    return failures;
}

// 脉冲宽度恰好等于延迟（==d）应通过：out 在 t=5 变 0，t=8 恢复 1
static int test_pulse_exactly_delay() {
    Simulator sim;
    auto in  = sim.add_signal("in",  Logic::Low);
    auto out = sim.add_signal("out", Logic::High);
    sim.add_gate(GateKind::Not, {in}, out, 3);
    sim.set_input(in, 2, Logic::High);
    sim.set_input(in, 5, Logic::Low);
    sim.run();
    check_history(sim, out, {{0,0,'1'},{5,0,'0'},{8,0,'1'}}, "exact out");
    check_ticks(sim, out, "111110001", "exact out 逐tick");
    return failures;
}

// XOR d=1：t=2 事件到期与激励 b->1 同 tick，out 仅短暂为 1
static int test_xor_same_tick() {
    Simulator sim;
    auto a   = sim.add_signal("a",   Logic::Low);
    auto b   = sim.add_signal("b",   Logic::Low);
    auto out = sim.add_signal("out", Logic::Low);
    sim.add_gate(GateKind::Xor, {a, b}, out, 1);
    sim.set_input(a, 1, Logic::High);
    sim.set_input(b, 2, Logic::High);
    sim.run();
    check_history(sim, out, {{0,0,'0'},{2,0,'1'},{3,0,'0'}}, "xor out");
    check_ticks(sim, out, "0010", "xor out 逐tick");
    return failures;
}

// 零延迟自反馈环路必须在 delta 轮内报不收敛
static int test_delta_loop() {
    Simulator sim;
    auto x = sim.add_signal("x", Logic::Low);
    sim.add_gate(GateKind::Not, {x}, x, 0);
    try {
        sim.run();
    } catch (const std::runtime_error& e) {
        if (std::string(e.what()).find("不收敛") == std::string::npos)
            fail("异常消息不含“不收敛”");
        return failures;
    }
    fail("零延迟环路未抛出异常");
    return failures;
}

int main(int argc, char** argv) {
    if (argc != 2) {
        std::cerr << "usage: gatesim_tests <case>\n";
        return 2;
    }
    const std::string name = argv[1];
    int rc = 2;
    if      (name == "inertial_cancel")      rc = test_inertial_cancel();
    else if (name == "stale_event")          rc = test_stale_event();
    else if (name == "zero_delay_delta")     rc = test_zero_delay_delta();
    else if (name == "same_tick_order")      rc = test_same_tick_order();
    else if (name == "pulse_exactly_delay")  rc = test_pulse_exactly_delay();
    else if (name == "xor_same_tick")        rc = test_xor_same_tick();
    else if (name == "delta_loop")           rc = test_delta_loop();
    else { std::cerr << "unknown case: " << name << "\n"; return 2; }
    std::cout << (rc == 0 ? "PASS " : "FAIL ") << name << "\n";
    return rc == 0 ? 0 : 1;
}
