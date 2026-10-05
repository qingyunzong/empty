// gatesim 测试：定向用例 + 与逐 tick 参考模型的随机交叉核对
#include <cstdlib>
#include <functional>
#include <iostream>
#include <map>
#include <random>
#include <set>
#include <string>
#include <vector>

#include "gatesim.hpp"
#include "reference_model.hpp"

using namespace gatesim;

namespace {

int g_failures = 0;

#define CHECK(cond)                                                          \
    do {                                                                     \
        if (!(cond)) {                                                       \
            ++g_failures;                                                    \
            std::cerr << "FAIL " << __FILE__ << ":" << __LINE__ << ": "      \
                      << #cond << "\n";                                      \
        }                                                                    \
    } while (0)

// 收集某节点的所有变化 (time, delta, value)
std::vector<std::tuple<std::uint64_t, int, Logic>> node_changes(const Simulator& sim,
                                                                std::size_t node) {
    std::vector<std::tuple<std::uint64_t, int, Logic>> out;
    for (const auto& c : sim.changes())
        if (c.node == node) out.emplace_back(c.time, c.delta, c.new_value);
    return out;
}

// 1. 宽度 < 延迟的脉冲被惯性取消；旧代事件出队被跳过
void test_inertial_cancel() {
    Simulator sim;
    auto a = sim.add_node("a");
    auto n = sim.add_node("n");
    sim.add_gate("g1", GateKind::Buf, {a}, n, 2);
    sim.add_stimulus(2, a, Logic::L1);
    sim.add_stimulus(3, a, Logic::L0);  // 宽度 1 < 2
    sim.run(10);

    CHECK(node_changes(sim, n).empty());
    CHECK(sim.cancels().size() == 1);
    if (!sim.cancels().empty()) {
        CHECK(sim.cancels()[0].time == 3);
        CHECK(sim.cancels()[0].cancelled_value == Logic::L1);
        CHECK(sim.cancels()[0].was_fire_time == 4);
    }
    CHECK(sim.stale_events().size() == 1);
    if (!sim.stale_events().empty()) CHECK(sim.stale_events()[0].time == 4);
    for (const auto& s : sim.snapshots()) CHECK(s[n] == Logic::L0);
}

// 2. 宽度 == 延迟的脉冲通过；到期事件与输入同 tick 时仍触发（先输入后门更新）
void test_pulse_equal_delay() {
    Simulator sim;
    auto a = sim.add_node("a");
    auto n = sim.add_node("n");
    sim.add_gate("g1", GateKind::Buf, {a}, n, 2);
    sim.add_stimulus(2, a, Logic::L1);
    sim.add_stimulus(4, a, Logic::L0);  // 宽度 2 == 延迟
    sim.run(10);

    auto ch = node_changes(sim, n);
    CHECK(ch.size() == 2);
    if (ch.size() == 2) {
        CHECK(std::get<0>(ch[0]) == 4 && std::get<2>(ch[0]) == Logic::L1);  // 与输入下降沿同 tick
        CHECK(std::get<0>(ch[1]) == 6 && std::get<2>(ch[1]) == Logic::L0);
    }
    CHECK(sim.cancels().empty());
    const auto& snaps = sim.snapshots();
    for (std::size_t t = 0; t < snaps.size(); ++t) {
        Logic expect = (t == 4 || t == 5) ? Logic::L1 : Logic::L0;
        CHECK(snaps[t][n] == expect);
    }
}

// 3. 旧代延迟事件不生效：多次翻转只留下最新代
void test_stale_generation() {
    Simulator sim;
    auto a = sim.add_node("a");
    auto n = sim.add_node("n");
    sim.add_gate("g1", GateKind::Buf, {a}, n, 3);
    sim.add_stimulus(1, a, Logic::L1);   // 调度 n=1 @4 (gen1)
    sim.add_stimulus(2, a, Logic::L0);   // 取消 gen1
    sim.add_stimulus(3, a, Logic::L1);   // 调度 n=1 @6 (gen2)
    sim.add_stimulus(10, a, Logic::L0);  // 调度 n=0 @13
    sim.run(16);

    auto ch = node_changes(sim, n);
    CHECK(ch.size() == 2);
    if (ch.size() == 2) {
        CHECK(std::get<0>(ch[0]) == 6 && std::get<2>(ch[0]) == Logic::L1);
        CHECK(std::get<0>(ch[1]) == 13 && std::get<2>(ch[1]) == Logic::L0);
    }
    CHECK(sim.cancels().size() == 1);
    CHECK(sim.stale_events().size() == 1);  // gen1 事件 @4 出队被跳过
    if (!sim.stale_events().empty()) {
        CHECK(sim.stale_events()[0].time == 4);
        CHECK(sim.stale_events()[0].event_gen != sim.stale_events()[0].current_gen);
    }
}

// 4. 零延迟门：同 tick 内按 delta 轮逐级传播
void test_zero_delay_delta() {
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

    CHECK(sim.changes().size() == 4);  // stimulus(a) + 3 级 delta
    if (sim.changes().size() == 4) {
        const auto& c = sim.changes();
        CHECK(c[0].time == 3 && c[0].node == a && c[0].delta == 0 && c[0].new_value == Logic::L1);
        CHECK(c[1].time == 3 && c[1].node == n1 && c[1].delta == 1 && c[1].new_value == Logic::L0);
        CHECK(c[2].time == 3 && c[2].node == n2 && c[2].delta == 2 && c[2].new_value == Logic::L1);
        CHECK(c[3].time == 3 && c[3].node == n3 && c[3].delta == 3 && c[3].new_value == Logic::L0);
    }
    const auto& snaps = sim.snapshots();
    for (std::size_t t = 3; t < snaps.size(); ++t) {
        CHECK(snaps[t][n1] == Logic::L0);
        CHECK(snaps[t][n2] == Logic::L1);
        CHECK(snaps[t][n3] == Logic::L0);
    }
}

// 5. 两个不同延迟 + 零延迟 XOR：毛刺波形（手算期望值）
void test_xor_glitch() {
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

    // 手算: n1: 1@3, 0@7; n2: 1@5, 0@9; out = n1^n2: 1@3, 0@5, 1@7, 0@9
    auto ch = node_changes(sim, out);
    CHECK(ch.size() == 4);
    if (ch.size() == 4) {
        const std::uint64_t expect_t[4] = {3, 5, 7, 9};
        const Logic expect_v[4] = {Logic::L1, Logic::L0, Logic::L1, Logic::L0};
        for (int i = 0; i < 4; ++i) {
            CHECK(std::get<0>(ch[i]) == expect_t[i]);
            CHECK(std::get<2>(ch[i]) == expect_v[i]);
            CHECK(std::get<1>(ch[i]) == 1);  // 零延迟门输出在 delta 1
        }
    }
}

// 6. 延迟环路：两个 NOT d=1 构成周期 2 振荡器，并与参考模型核对
void test_delay_loop() {
    Simulator sim;
    auto n1 = sim.add_node("n1");
    auto n2 = sim.add_node("n2");
    sim.add_gate("g1", GateKind::Not, {n2}, n1, 1);
    sim.add_gate("g2", GateKind::Not, {n1}, n2, 1);
    const std::uint64_t T = 10;
    sim.run(T);

    const auto& snaps = sim.snapshots();
    for (std::size_t t = 0; t < snaps.size(); ++t) {
        Logic expect = (t % 2 == 1) ? Logic::L1 : Logic::L0;
        CHECK(snaps[t][n1] == expect);
        CHECK(snaps[t][n2] == expect);
    }

    refmodel::Circuit c;
    c.init = {Logic::L0, Logic::L0};
    c.kinds = {GateKind::Not, GateKind::Not};
    c.inputs = {{1}, {0}};
    c.outputs = {0, 1};
    c.delays = {1, 1};
    auto ref = refmodel::run(c, {}, T);
    for (std::size_t t = 0; t < T; ++t)
        for (std::size_t n = 0; n < 2; ++n) CHECK(snaps[t][n] == ref[t][n]);
}

// 7. 随机 DAG 电路 + 随机激励：事件驱动仿真 vs 逐 tick 参考模型
void test_random_crosscheck() {
    constexpr int kSeeds = 200;
    constexpr std::uint64_t T = 50;
    constexpr std::size_t kInputs = 3;
    int mismatches = 0;

    for (int seed = 0; seed < kSeeds; ++seed) {
        std::mt19937_64 rng(static_cast<std::uint64_t>(seed) * 2654435761u + 12345u);
        Simulator sim;
        refmodel::Circuit c;

        for (std::size_t i = 0; i < kInputs; ++i) {
            sim.add_node("in" + std::to_string(i));
            c.init.push_back(Logic::L0);
        }
        const std::size_t num_gates = 4 + rng() % 8;
        for (std::size_t g = 0; g < num_gates; ++g) {
            std::size_t out = sim.add_node("n" + std::to_string(g));
            c.init.push_back(Logic::L0);
            GateKind kind = static_cast<GateKind>(rng() % 7);
            bool unary = (kind == GateKind::Buf || kind == GateKind::Not);
            std::size_t arity = unary ? 1 : 1 + rng() % 2;
            std::vector<std::size_t> ins;
            for (std::size_t k = 0; k < arity; ++k) ins.push_back(rng() % out);  // DAG
            int delay = static_cast<int>(rng() % 4);  // 0..3
            sim.add_gate("g" + std::to_string(g), kind, ins, out, delay);
            c.kinds.push_back(kind);
            c.inputs.push_back(ins);
            c.outputs.push_back(out);
            c.delays.push_back(delay);
        }

        refmodel::Stimuli stim(T);
        for (std::size_t i = 0; i < kInputs; ++i) {
            std::size_t k = 2 + rng() % 5;
            std::set<std::uint64_t> times;
            while (times.size() < k) times.insert(rng() % T);
            Logic v = Logic::L1;
            for (std::uint64_t t : times) {
                sim.add_stimulus(t, i, v);
                stim[t].emplace_back(i, v);
                v = (v == Logic::L1) ? Logic::L0 : Logic::L1;
            }
        }

        sim.run(T);
        auto ref = refmodel::run(c, stim, T);

        // 快照逐点比较
        for (std::size_t t = 0; t < T && mismatches < 20; ++t)
            for (std::size_t n = 0; n < sim.node_count(); ++n)
                if (sim.snapshots()[t][n] != ref[t][n]) {
                    ++mismatches;
                    std::cerr << "MISMATCH seed=" << seed << " t=" << t << " node=" << n
                              << " sim=" << to_char(sim.snapshots()[t][n])
                              << " ref=" << to_char(ref[t][n]) << "\n";
                }

        // 变化记录回放一致性：按时间回放所有 change 应等于快照
        std::vector<Logic> state = c.init;
        std::size_t ci = 0;
        for (std::size_t t = 0; t < T; ++t) {
            while (ci < sim.changes().size() && sim.changes()[ci].time == t) {
                state[sim.changes()[ci].node] = sim.changes()[ci].new_value;
                ++ci;
            }
            if (state != sim.snapshots()[t]) {
                ++mismatches;
                std::cerr << "REPLAY MISMATCH seed=" << seed << " t=" << t << "\n";
            }
        }
    }
    CHECK(mismatches == 0);
    std::cout << "random_crosscheck: " << kSeeds << " seeds x " << T << " ticks passed\n";
}

const std::map<std::string, std::function<void()>>& tests() {
    static const std::map<std::string, std::function<void()>> kTests = {
        {"inertial_cancel", test_inertial_cancel},
        {"pulse_equal_delay", test_pulse_equal_delay},
        {"stale_generation", test_stale_generation},
        {"zero_delay_delta", test_zero_delay_delta},
        {"xor_glitch", test_xor_glitch},
        {"delay_loop", test_delay_loop},
        {"random_crosscheck", test_random_crosscheck},
    };
    return kTests;
}

}  // namespace

int main(int argc, char** argv) {
    if (argc == 2 && std::string(argv[1]) == "--list") {
        for (const auto& [name, fn] : tests()) std::cout << name << "\n";
        return 0;
    }
    if (argc != 2) {
        std::cerr << "usage: " << argv[0] << " <test-name|--list>\n";
        return 2;
    }
    auto it = tests().find(argv[1]);
    if (it == tests().end()) {
        std::cerr << "unknown test: " << argv[1] << "\n";
        return 2;
    }
    it->second();
    if (g_failures > 0) {
        std::cerr << argv[1] << ": " << g_failures << " failure(s)\n";
        return 1;
    }
    std::cout << argv[1] << ": PASS\n";
    return 0;
}
