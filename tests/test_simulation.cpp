#include <motion/simulation.hpp>

#include <stdexcept>

#include "check.hpp"

using motion::Event;
using motion::Particle;
using motion::Rational;
using motion::Simulation;

static Rational R(long long num, long long den = 1) {
    return Rational(motion::BigInt(num), motion::BigInt(den));
}

static Particle P(long long pos, long long vnum, long long vden = 1) {
    return Particle{R(pos), R(vnum, vden)};
}

int main() {
    // 1. 两粒子对撞：精确事件时间 5/2，速度交换。
    {
        Simulation sim({P(0, 3), P(10, -1)});
        auto e = sim.step();
        CHECK(e.has_value());
        CHECK(e->time == R(5, 2));
        CHECK(e->groups.size() == 1);
        CHECK(e->groups[0].first == 0 && e->groups[0].last == 1);
        CHECK(sim.particles()[0].velocity == R(-1));
        CHECK(sim.particles()[1].velocity == R(3));
        CHECK(sim.particles()[0].position == R(15, 2));
        CHECK(sim.particles()[1].position == R(15, 2));
        CHECK(!sim.step().has_value());
    }

    // 2. 同向追赶：t = 5。
    {
        Simulation sim({P(0, 2), P(5, 1)});
        auto e = sim.step();
        CHECK(e.has_value());
        CHECK(e->time == R(5));
        CHECK(sim.particles()[0].position == R(10));
        CHECK(sim.particles()[1].position == R(10));
    }

    // 3. 远离 / 等速：无事件。
    {
        Simulation sim({P(0, -1), P(3, 2)});
        CHECK(!sim.step().has_value());
        Simulation same({P(0, 1), P(3, 1)});
        CHECK(!same.step().has_value());
    }

    // 4. 三粒子同刻相遇：单个连续接触组整体反转速度。
    {
        Simulation sim({P(0, 2), P(1, 1), P(2, 0)});
        auto e = sim.step();
        CHECK(e.has_value());
        CHECK(e->time == R(1));
        CHECK(e->groups.size() == 1);
        CHECK(e->groups[0].first == 0 && e->groups[0].last == 2);
        CHECK(sim.particles()[0].velocity == R(0));
        CHECK(sim.particles()[1].velocity == R(1));
        CHECK(sim.particles()[2].velocity == R(2));
        for (const auto& p : sim.particles()) CHECK(p.position == R(2));
        CHECK(!sim.step().has_value());
    }

    // 5. 零距初态先处理：t = 0 的事件先于后续事件。
    {
        Simulation sim({P(0, 1), P(0, -1), P(5, 0)});
        auto e0 = sim.step();
        CHECK(e0.has_value());
        CHECK(e0->time == R(0));
        CHECK(e0->groups.size() == 1);
        CHECK(e0->groups[0].first == 0 && e0->groups[0].last == 1);
        CHECK(sim.particles()[0].velocity == R(-1));
        CHECK(sim.particles()[1].velocity == R(1));
        auto e1 = sim.step();
        CHECK(e1.has_value());
        CHECK(e1->time == R(5));
        CHECK(e1->groups[0].first == 1 && e1->groups[0].last == 2);
        CHECK(!sim.step().has_value());
    }

    // 6. 同一时刻两个独立接触组。
    {
        Simulation sim({P(0, 1), P(2, 0), P(5, 1), P(7, 0)});
        auto e = sim.step();
        CHECK(e.has_value());
        CHECK(e->time == R(2));
        CHECK(e->groups.size() == 2);
        CHECK(e->groups[0].first == 0 && e->groups[0].last == 1);
        CHECK(e->groups[1].first == 2 && e->groups[1].last == 3);
        // 此后粒子 1 (v=1) 于 t=7 追上粒子 2 (v=0)。
        auto e2 = sim.step();
        CHECK(e2.has_value());
        CHECK(e2->time == R(7));
        CHECK(e2->groups.size() == 1);
        CHECK(e2->groups[0].first == 1 && e2->groups[0].last == 2);
        CHECK(!sim.step().has_value());
    }

    // 7. 零距链式解析：同刻多个 t = 0 事件直至组内速度有序。
    {
        Simulation sim({P(0, 2), P(0, 3), P(0, 1)});
        auto events = sim.run(10);
        CHECK(events.size() == 2);
        CHECK(events[0].time == R(0));
        CHECK(events[0].groups.size() == 1);
        CHECK(events[0].groups[0].first == 1 && events[0].groups[0].last == 2);
        CHECK(events[1].time == R(0));
        CHECK(events[1].groups.size() == 1);
        CHECK(events[1].groups[0].first == 0 && events[1].groups[0].last == 1);
        CHECK(sim.particles()[0].velocity == R(1));
        CHECK(sim.particles()[1].velocity == R(2));
        CHECK(sim.particles()[2].velocity == R(3));
    }

    // 8. 有理速度产生的分数事件时间。
    {
        Simulation sim({P(0, 1, 2), P(1, 0)});  // v = 1/2 追静止粒子
        auto e = sim.step();
        CHECK(e.has_value());
        CHECK(e->time == R(2));
        Simulation sim2({P(0, 2, 3), P(5, 1, 3)});  // dt = 5 / (1/3) = 15
        auto e2 = sim2.step();
        CHECK(e2.has_value());
        CHECK(e2->time == R(15));
        CHECK(sim2.particles()[0].position == R(10));
    }

    // 9. 未按位置排序的输入被拒绝。
    {
        bool threw = false;
        try {
            Simulation bad({P(5, 0), P(0, 0)});
            (void)bad;
        } catch (const std::invalid_argument&) {
            threw = true;
        }
        CHECK(threw);
    }

    return tst::summary();
}
