#include "trafficsim/simulator.hpp"

#include <functional>
#include <iostream>
#include <map>
#include <random>
#include <stdexcept>
#include <string>
#include <vector>

using namespace trafficsim;

#define CHECK(cond)                                                                            \
    do {                                                                                       \
        if (!(cond))                                                                           \
            throw std::runtime_error(std::string("CHECK failed: ") + #cond + " (line " +       \
                                     std::to_string(__LINE__) + ")");                          \
    } while (0)

namespace {

const Reservation* findReservation(const TickReport& r, int id) {
    for (const auto& res : r.reservations)
        if (res.vehicle_id == id) return &res;
    return nullptr;
}

const Rejection* findRejection(const TickReport& r, int id) {
    for (const auto& rej : r.rejections)
        if (rej.vehicle_id == id) return &rej;
    return nullptr;
}

const VehicleSnapshot* findAfter(const TickReport& r, int id) {
    for (const auto& s : r.after)
        if (s.id == id) return &s;
    return nullptr;
}

Vehicle makeVehicle(int id, bool emergency, std::vector<Cell> route, int wait = 0) {
    Vehicle v;
    v.id = id;
    v.emergency = emergency;
    v.route = std::move(route);
    v.wait = wait;
    return v;
}

// 仲裁顺序: 等待时长降序, 再 ID 升序
void priority_wait_then_id() {
    Simulator sim;
    // 三条互不冲突的平行路线
    sim.addVehicle(makeVehicle(10, false, {{0, 0}, {1, 0}}, /*wait=*/2));
    sim.addVehicle(makeVehicle(11, false, {{0, 2}, {1, 2}}, /*wait=*/5));
    sim.addVehicle(makeVehicle(12, false, {{0, 4}, {1, 4}}, /*wait=*/5));
    const auto before = sim.vehicles();
    const TickReport r = sim.tick();
    CHECK(r.reservations.size() == 3);
    // wait=5 的两辆按 ID 升序在前, wait=2 的最后
    CHECK(r.reservations[0].vehicle_id == 11);
    CHECK(r.reservations[1].vehicle_id == 12);
    CHECK(r.reservations[2].vehicle_id == 10);
    CHECK(verifyTick(before, r).empty());
}

// 应急车仅提高优先级: 等待 0 的应急车竞争同一目标格时胜过等待 5 的普通车
void emergency_boosts_priority() {
    Simulator sim;
    sim.addVehicle(makeVehicle(1, false, {{0, 0}, {1, 0}, {2, 0}}, /*wait=*/5));
    sim.addVehicle(makeVehicle(2, true, {{1, 1}, {1, 0}, {2, 0}}, /*wait=*/0));
    // 两车目标格均为 (1,0); 应急车 #2 虽等待更短仍先仲裁并通行, #1 被拒
    const auto before = sim.vehicles();
    const TickReport r = sim.tick();
    CHECK(r.reservations[0].vehicle_id == 2);
    CHECK(findReservation(r, 2)->moved);
    CHECK(!findReservation(r, 1)->moved);
    CHECK(findRejection(r, 1)->conflict_with == 2);
    CHECK(verifyTick(before, r).empty());
}

// 应急车不豁免冲突规则: 目标格被占用时照样被拒
void emergency_not_exempt_from_conflict() {
    Simulator sim;
    sim.addVehicle(makeVehicle(1, false, {{0, 0}, {1, 0}, {2, 0}}, /*wait=*/9));
    sim.addVehicle(makeVehicle(2, true, {{1, 0}, {2, 0}, {3, 0}}, /*wait=*/0));
    // #2 应急车目标 (2,0), #1 目标 (1,0) — 即 #2 的当前格; #1 先仲裁占用 {(0,0),(1,0)}
    // #2 目标 (2,0) 空闲, 但 #1 想进入 (1,0) 被 #2 占用? 仲裁顺序: #1(wait=9) 先,
    // #1 目标 (1,0) 在 tick 开始时被 #2 占用 -> #1 被拒; #2 通行
    const auto before = sim.vehicles();
    const TickReport r = sim.tick();
    CHECK(!findReservation(r, 1)->moved);
    CHECK(findReservation(r, 2)->moved);
    CHECK(findRejection(r, 1) != nullptr);
    CHECK(verifyTick(before, r).empty());
}

// 冲突拒绝: 两车竞争同一目标格, 低优先级被拒且理由指向真实冲突
void conflict_rejection_reason() {
    Simulator sim;
    sim.addVehicle(makeVehicle(1, false, {{0, 0}, {1, 0}, {2, 0}}, /*wait=*/3));
    sim.addVehicle(makeVehicle(2, false, {{2, 1}, {1, 1}, {1, 0}}, /*wait=*/1));
    // #1 目标 (1,0), #2 目标 (1,1) — 不冲突; 让 #2 也瞄准 (1,0):
    Simulator sim2;
    sim2.addVehicle(makeVehicle(1, false, {{0, 0}, {1, 0}, {2, 0}}, /*wait=*/3));
    sim2.addVehicle(makeVehicle(2, false, {{1, 1}, {1, 0}, {2, 0}}, /*wait=*/1));
    const auto before = sim2.vehicles();
    const TickReport r = sim2.tick();
    CHECK(findReservation(r, 1)->moved);
    CHECK(!findReservation(r, 2)->moved);
    const Rejection* rej = findRejection(r, 2);
    CHECK(rej != nullptr);
    CHECK(rej->conflict_cell == (Cell{1, 0}));
    CHECK(rej->conflict_with == 1);
    CHECK(!rej->reason.empty());
    CHECK(verifyTick(before, r).empty());
}

// 目标格在 tick 开始时被占用即拒绝, 即使占位者本 tick 移走 (不链式跟随)
void occupied_target_blocks_even_if_vacated() {
    Simulator sim;
    sim.addVehicle(makeVehicle(1, false, {{2, 0}, {3, 0}, {4, 0}}, /*wait=*/0));
    sim.addVehicle(makeVehicle(2, false, {{1, 0}, {2, 0}, {3, 0}}, /*wait=*/0));
    // #1 先仲裁 (ID 小): (2,0)->(3,0); #2 目标 (2,0) 在 tick 开始时被 #1 占用 -> 拒
    const auto before = sim.vehicles();
    const TickReport r = sim.tick();
    CHECK(findReservation(r, 1)->moved);
    CHECK(!findReservation(r, 2)->moved);
    CHECK(findRejection(r, 2)->conflict_with == 1);
    CHECK(verifyTick(before, r).empty());
}

// 对头互换: 双方目标格互被对方占用, 都被拒, 无碰撞
void head_on_swap_blocked() {
    Simulator sim;
    sim.addVehicle(makeVehicle(1, false, {{0, 0}, {1, 0}, {2, 0}}));
    sim.addVehicle(makeVehicle(2, false, {{1, 0}, {0, 0}}));
    const auto before = sim.vehicles();
    const TickReport r = sim.tick();
    CHECK(!findReservation(r, 1)->moved);
    CHECK(!findReservation(r, 2)->moved);
    CHECK(findAfter(r, 1)->wait == 1);
    CHECK(findAfter(r, 2)->wait == 1);
    CHECK(verifyTick(before, r).empty());
}

// 等待累加: 被拒 wait/total_wait +1, 通行后 wait 归零
void wait_accumulation() {
    Simulator sim;
    sim.addVehicle(makeVehicle(1, false, {{0, 0}, {1, 0}, {2, 0}, {3, 0}}, /*wait=*/0));
    sim.addVehicle(makeVehicle(2, false, {{1, 0}, {2, 0}, {3, 0}}, /*wait=*/0));
    // tick0: #1 目标 (1,0) 被 #2 占用 -> 拒; #2 目标 (2,0) 空闲 -> 通行
    auto before = sim.vehicles();
    auto r = sim.tick();
    CHECK(verifyTick(before, r).empty());
    CHECK(findAfter(r, 1)->wait == 1);
    CHECK(findAfter(r, 1)->total_wait == 1);
    // tick1: #1(wait=1) 先仲裁, 目标 (1,0) 已空 -> 通行, wait 归零
    before = sim.vehicles();
    r = sim.tick();
    CHECK(verifyTick(before, r).empty());
    CHECK(findReservation(r, 1)->moved);
    CHECK(findAfter(r, 1)->wait == 0);
    CHECK(findAfter(r, 1)->total_wait == 1);
}

// 到达终点后离场, 全部到达后 done()
void arrival_and_done() {
    Simulator sim;
    sim.addVehicle(makeVehicle(1, false, {{0, 0}, {1, 0}}));
    CHECK(!sim.done());
    auto before = sim.vehicles();
    auto r = sim.tick();  // 到达 (1,0)
    CHECK(verifyTick(before, r).empty());
    CHECK(findAfter(r, 1)->arrived);
    before = sim.vehicles();
    r = sim.tick();  // 离场
    CHECK(verifyTick(before, r).empty());
    CHECK(r.arrived.size() == 1 && r.arrived[0] == 1);
    CHECK(sim.done());
}

// 随机场景逐格占用参考核验: 任意 tick 无碰撞且等待累加正确
void randomized_no_collision_and_wait_check() {
    std::mt19937 rng(20261007);
    constexpr int kGrid = 6;
    constexpr int kVehicles = 12;
    constexpr int kTicks = 300;

    Simulator sim;
    std::uniform_int_distribution<int> coord(0, kGrid - 1);
    std::uniform_int_distribution<int> dir(0, 1);
    std::uniform_int_distribution<int> len(2, 5);
    std::uniform_int_distribution<int> emerg(0, 4);

    int added = 0;
    while (added < kVehicles) {
        const int length = len(rng);
        std::vector<Cell> route;
        Cell c{coord(rng), coord(rng)};
        route.push_back(c);
        // 随机曼哈顿路径
        while (static_cast<int>(route.size()) < length) {
            Cell target{coord(rng), coord(rng)};
            while (!(target == route.back()) && static_cast<int>(route.size()) < length) {
                Cell step = route.back();
                if (step.x != target.x && (step.y == target.y || dir(rng) == 0))
                    step.x += (target.x > step.x) ? 1 : -1;
                else
                    step.y += (target.y > step.y) ? 1 : -1;
                route.push_back(step);
            }
        }
        try {
            sim.addVehicle(makeVehicle(added + 1, emerg(rng) == 0, route));
            ++added;
        } catch (const std::invalid_argument&) {
            // 起点冲突, 重新生成
        }
    }

    int ticks = 0;
    while (!sim.done() && ticks < kTicks) {
        const auto before = sim.vehicles();
        const TickReport r = sim.tick();
        const std::string err = verifyTick(before, r);
        CHECK(err.empty());
        ++ticks;
    }
    CHECK(ticks > 10);  // 场景确实发生了足够多的交互
}

// 非法输入校验
void invalid_input_rejected() {
    Simulator sim;
    bool threw = false;
    try {
        sim.addVehicle(makeVehicle(1, false, {}));
    } catch (const std::invalid_argument&) { threw = true; }
    CHECK(threw);

    threw = false;
    try {
        sim.addVehicle(makeVehicle(2, false, {{0, 0}, {2, 0}}));  // 不相邻
    } catch (const std::invalid_argument&) { threw = true; }
    CHECK(threw);

    sim.addVehicle(makeVehicle(3, false, {{0, 0}, {1, 0}}));
    threw = false;
    try {
        sim.addVehicle(makeVehicle(4, false, {{0, 0}, {0, 1}}));  // 起点重叠
    } catch (const std::invalid_argument&) { threw = true; }
    CHECK(threw);
}

const std::map<std::string, std::function<void()>>& cases() {
    static const std::map<std::string, std::function<void()>> kCases = {
        {"priority_wait_then_id", priority_wait_then_id},
        {"emergency_boosts_priority", emergency_boosts_priority},
        {"emergency_not_exempt_from_conflict", emergency_not_exempt_from_conflict},
        {"conflict_rejection_reason", conflict_rejection_reason},
        {"occupied_target_blocks_even_if_vacated", occupied_target_blocks_even_if_vacated},
        {"head_on_swap_blocked", head_on_swap_blocked},
        {"wait_accumulation", wait_accumulation},
        {"arrival_and_done", arrival_and_done},
        {"randomized_no_collision_and_wait_check", randomized_no_collision_and_wait_check},
        {"invalid_input_rejected", invalid_input_rejected},
    };
    return kCases;
}

} // namespace

int main(int argc, char** argv) {
    try {
        if (argc == 2) {
            const auto it = cases().find(argv[1]);
            if (it == cases().end()) {
                std::cerr << "unknown case: " << argv[1] << "\n";
                return 2;
            }
            it->second();
            std::cout << "PASS " << argv[1] << "\n";
            return 0;
        }
        for (const auto& [name, fn] : cases()) {
            fn();
            std::cout << "PASS " << name << "\n";
        }
        return 0;
    } catch (const std::exception& e) {
        std::cerr << "FAIL: " << e.what() << "\n";
        return 1;
    }
}
