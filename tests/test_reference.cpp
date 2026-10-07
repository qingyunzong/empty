// 细分事件参考核验：
// 参考实现不使用“连续接触组整体反转”，而是把每个接触时刻细分为
// 一系列相邻两两交换（每次只交换一对同位且接近的粒子，直至该时刻
// 无可交换对）。核验库实现与该细分参考产生相同的不同时刻序列与
// 相同的最终状态，并检查守恒量与不变式。

#include <motion/simulation.hpp>

#include <algorithm>
#include <cstdint>
#include <optional>
#include <vector>

#include "check.hpp"

using motion::BigInt;
using motion::Event;
using motion::Particle;
using motion::Rational;
using motion::Simulation;

static Rational R(long long num, long long den = 1) {
    return Rational(BigInt(num), BigInt(den));
}

struct RefResult {
    std::vector<Rational> times;  // 每个不同的接触时刻
    std::vector<Rational> positions;
    std::vector<Rational> velocities;
};

// 细分参考：每个事件时刻内反复执行相邻两两交换。
static RefResult reference_run(std::vector<Particle> particles, std::size_t max_events) {
    RefResult result;
    Rational t(0);
    const std::size_t n = particles.size();
    for (std::size_t step = 0; step < max_events; ++step) {
        bool found = false;
        Rational best;
        for (std::size_t i = 0; i + 1 < n; ++i) {
            if (particles[i].velocity <= particles[i + 1].velocity) continue;
            Rational dt = (particles[i + 1].position - particles[i].position) /
                          (particles[i].velocity - particles[i + 1].velocity);
            if (!found || dt < best) {
                best = dt;
                found = true;
            }
        }
        if (!found) break;
        t += best;
        for (auto& p : particles) p.position += p.velocity * best;
        // 细分：逐对交换，直到该时刻所有同位粒子速度有序。
        bool swapped = true;
        while (swapped) {
            swapped = false;
            for (std::size_t i = 0; i + 1 < n; ++i) {
                if (particles[i].position == particles[i + 1].position &&
                    particles[i].velocity > particles[i + 1].velocity) {
                    std::swap(particles[i].velocity, particles[i + 1].velocity);
                    swapped = true;
                }
            }
        }
        result.times.push_back(t);
    }
    for (const auto& p : particles) {
        result.positions.push_back(p.position);
        result.velocities.push_back(p.velocity);
    }
    return result;
}

static std::vector<Rational> distinct_times(const std::vector<Event>& events) {
    std::vector<Rational> times;
    for (const auto& e : events)
        if (times.empty() || times.back() != e.time) times.push_back(e.time);
    return times;
}

static std::vector<Rational> velocities_of(const std::vector<Particle>& ps) {
    std::vector<Rational> v;
    for (const auto& p : ps) v.push_back(p.velocity);
    return v;
}

static std::vector<Rational> positions_of(const std::vector<Particle>& ps) {
    std::vector<Rational> v;
    for (const auto& p : ps) v.push_back(p.position);
    return v;
}

static void check_invariants(const std::vector<Particle>& initial,
                             const std::vector<Event>& events,
                             const std::vector<Particle>& final) {
    // 速度多重集守恒
    auto v0 = velocities_of(initial);
    auto v1 = velocities_of(final);
    std::sort(v0.begin(), v0.end());
    std::sort(v1.begin(), v1.end());
    CHECK(v0 == v1);
    // 动量守恒
    Rational p0(0), p1(0);
    for (const auto& p : initial) p0 += p.velocity;
    for (const auto& p : final) p1 += p.velocity;
    CHECK(p0 == p1);
    // 事件时间单调不减
    for (std::size_t i = 1; i < events.size(); ++i)
        CHECK(events[i - 1].time <= events[i].time);
    // 位置始终保持非降（无穿透）
    for (std::size_t i = 1; i < final.size(); ++i)
        CHECK(final[i - 1].position <= final[i].position);
}

// 对库返回的每个事件核验：组内粒子同位置，且事件后组内速度严格递增。
static void check_event_groups(std::vector<Particle> particles, std::size_t max_events) {
    Simulation sim(std::move(particles));
    for (std::size_t k = 0; k < max_events; ++k) {
        auto e = sim.step();
        if (!e) break;
        const auto& ps = sim.particles();
        for (const auto& g : e->groups) {
            for (std::size_t i = g.first; i < g.last; ++i) {
                CHECK(ps[i].position == ps[i + 1].position);
                CHECK(ps[i].velocity < ps[i + 1].velocity);
            }
        }
    }
}

int main() {
    // 1. 三粒子同刻相遇：库给出 1 个组事件；细分参考给出同一时刻、同一终态。
    {
        std::vector<Particle> init{{R(0), R(2)}, {R(1), R(1)}, {R(2), R(0)}};
        Simulation sim(init);
        auto events = sim.run(10);
        CHECK(events.size() == 1);
        auto ref = reference_run(init, 10);
        CHECK(ref.times.size() == 1);
        CHECK(distinct_times(events) == ref.times);
        CHECK(velocities_of(sim.particles()) == ref.velocities);
        CHECK(positions_of(sim.particles()) == ref.positions);
        check_invariants(init, events, sim.particles());
    }

    // 2. 四粒子同点相遇（速度完全逆序）：组反转 = 细分交换序列。
    {
        std::vector<Particle> init{{R(0), R(3)}, {R(1), R(2)}, {R(2), R(1)}, {R(3), R(0)}};
        Simulation sim(init);
        auto events = sim.run(10);
        CHECK(events.size() == 1);
        CHECK(events[0].groups.size() == 1);
        CHECK(events[0].groups[0].first == 0 && events[0].groups[0].last == 3);
        auto ref = reference_run(init, 10);
        CHECK(velocities_of(sim.particles()) == ref.velocities);
        CHECK(velocities_of(sim.particles()) ==
              std::vector<Rational>({R(0), R(1), R(2), R(3)}));
        check_invariants(init, events, sim.particles());
    }

    // 3. 随机小系统交叉核验（含零距初态与有理速度）。
    std::uint64_t rng = 0x9e3779b97f4a7c15ull;
    auto next = [&]() {
        rng ^= rng << 13;
        rng ^= rng >> 7;
        rng ^= rng << 17;
        return rng;
    };
    constexpr std::size_t kMaxEvents = 200;
    for (int trial = 0; trial < 300; ++trial) {
        const std::size_t n = 2 + next() % 4;  // 2..5 个粒子
        std::vector<Particle> init;
        long long pos = 0;
        for (std::size_t i = 0; i < n; ++i) {
            pos += static_cast<long long>(next() % 3);  // 允许零间距
            long long vnum = static_cast<long long>(next() % 9) - 4;  // -4..4
            long long vden = 1 + static_cast<long long>(next() % 2);  // 1..2
            init.push_back({R(pos), R(vnum, vden)});
        }
        Simulation sim(init);
        auto events = sim.run(kMaxEvents);
        CHECK(events.size() < kMaxEvents);  // 应在限额内演化完毕
        auto ref = reference_run(init, kMaxEvents);
        CHECK(ref.times.size() < kMaxEvents);
        CHECK(distinct_times(events) == ref.times);
        CHECK(velocities_of(sim.particles()) == ref.velocities);
        CHECK(positions_of(sim.particles()) == ref.positions);
        check_invariants(init, events, sim.particles());
        check_event_groups(init, kMaxEvents);
    }

    return tst::summary();
}
