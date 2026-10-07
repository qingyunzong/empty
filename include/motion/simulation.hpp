#pragma once

#include <motion/rational.hpp>

#include <cstddef>
#include <optional>
#include <vector>

namespace motion {

// 一维粒子：初始位置为整数，速度为有理数；演化过程中位置变为有理数。
struct Particle {
    Rational position;
    Rational velocity;
};

// 连续接触组：粒子下标闭区间 [first, last]，组内粒子同刻同位置依次接触。
struct ContactGroup {
    std::size_t first;
    std::size_t last;

    friend bool operator==(const ContactGroup&, const ContactGroup&) = default;
};

// 一次接触事件：精确时刻 + 该时刻全部连续接触组（组内速度已整体反转）。
struct Event {
    Rational time;
    std::vector<ContactGroup> groups;
};

// 事件驱动模拟器：相邻粒子接触时交换速度；同刻多粒子接触按连续接触组
// 整体反转速度顺序。零距初态（初始即同位的粒子）作为 t = 0 的事件最先处理。
class Simulation {
public:
    // 粒子须按位置非降排列，否则抛 std::invalid_argument。
    explicit Simulation(std::vector<Particle> particles);

    const std::vector<Particle>& particles() const { return particles_; }
    const Rational& time() const { return time_; }

    // 推进到下一事件并返回之；再无事件时返回 std::nullopt。
    std::optional<Event> step();

    // 连续推进至多 max_events 个事件，返回事件序列。
    std::vector<Event> run(std::size_t max_events);

private:
    std::vector<Particle> particles_;
    Rational time_;
};

}  // namespace motion
