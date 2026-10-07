#include "trafficsim/simulator.hpp"

#include <algorithm>
#include <map>
#include <numeric>
#include <set>
#include <stdexcept>

namespace trafficsim {

namespace {

std::string cellStr(const Cell& c) {
    return "(" + std::to_string(c.x) + "," + std::to_string(c.y) + ")";
}

VehicleSnapshot snapshot(const Vehicle& v) {
    return {v.id, v.pos, v.wait, v.total_wait, v.arrived};
}

// 仲裁顺序: 应急车优先, 再按等待时长降序, 再按 ID 升序
bool higherPriority(const Vehicle& a, const Vehicle& b) {
    if (a.emergency != b.emergency) return a.emergency;
    if (a.wait != b.wait) return a.wait > b.wait;
    return a.id < b.id;
}

} // namespace

void Simulator::addVehicle(Vehicle v) {
    if (v.route.empty())
        throw std::invalid_argument("vehicle #" + std::to_string(v.id) + ": empty route");
    for (std::size_t i = 1; i < v.route.size(); ++i) {
        const int dist = std::abs(v.route[i].x - v.route[i - 1].x) +
                         std::abs(v.route[i].y - v.route[i - 1].y);
        if (dist != 1)
            throw std::invalid_argument("vehicle #" + std::to_string(v.id) +
                                        ": route cells not adjacent at index " + std::to_string(i));
    }
    for (const auto& other : vehicles_)
        if (other.id == v.id)
            throw std::invalid_argument("duplicate vehicle id #" + std::to_string(v.id));
    if (!v.atDestination())
        for (const auto& other : vehicles_)
            if (!other.atDestination() && other.cell() == v.cell())
                throw std::invalid_argument("vehicles #" + std::to_string(other.id) + " and #" +
                                            std::to_string(v.id) + " share start cell");
    vehicles_.push_back(std::move(v));
}

TickReport Simulator::tick() {
    TickReport report;
    report.tick_index = tick_count_++;

    // 1. 到达终点的车辆离场
    std::vector<Vehicle> remaining;
    for (auto& v : vehicles_) {
        if (v.atDestination()) {
            v.arrived = true;
            report.arrived.push_back(v.id);
            report.after.push_back(snapshot(v));
        } else {
            remaining.push_back(v);
        }
    }
    vehicles_ = std::move(remaining);

    // 2. 仲裁: 应急 > 等待时长 > ID
    std::vector<std::size_t> order(vehicles_.size());
    std::iota(order.begin(), order.end(), std::size_t{0});
    std::sort(order.begin(), order.end(),
              [&](std::size_t a, std::size_t b) { return higherPriority(vehicles_[a], vehicles_[b]); });

    // tick 开始时的占位 (车辆当前格)
    std::map<Cell, int> occupied;
    for (const auto& v : vehicles_) occupied.emplace(v.cell(), v.id);

    std::map<Cell, int> reserved;  // 本 tick 已确认的占用格 -> 车辆 id

    for (const std::size_t idx : order) {
        auto& v = vehicles_[idx];
        const Cell cur = v.cell();
        const Cell next = v.route[v.pos + 1];

        int conflict_with = -1;
        Cell conflict_cell{};
        std::string reason;

        if (const auto it = occupied.find(next); it != occupied.end()) {
            conflict_with = it->second;
            conflict_cell = next;
            reason = "目标格 " + cellStr(next) + " 在 tick 开始时被车辆 #" +
                     std::to_string(conflict_with) + " 占用";
        } else if (const auto it = reserved.find(next); it != reserved.end()) {
            conflict_with = it->second;
            conflict_cell = next;
            reason = "目标格 " + cellStr(next) + " 与车辆 #" + std::to_string(conflict_with) +
                     " 本 tick 占用冲突";
        } else if (const auto it = reserved.find(cur); it != reserved.end()) {
            conflict_with = it->second;
            conflict_cell = cur;
            reason = "当前格 " + cellStr(cur) + " 与车辆 #" + std::to_string(conflict_with) +
                     " 本 tick 占用冲突";
        }

        if (conflict_with < 0) {
            reserved.emplace(cur, v.id);
            reserved.emplace(next, v.id);
            ++v.pos;
            v.wait = 0;
            if (v.atDestination()) v.arrived = true;
            report.reservations.push_back({v.id, {cur, next}, true});
        } else {
            reserved.emplace(cur, v.id);
            ++v.wait;
            ++v.total_wait;
            report.reservations.push_back({v.id, {cur}, false});
            report.rejections.push_back({v.id, conflict_cell, conflict_with, std::move(reason)});
        }
        report.after.push_back(snapshot(v));
    }
    return report;
}

std::string verifyTick(const std::vector<Vehicle>& before, const TickReport& report) {
    std::map<int, const Vehicle*> beforeById;
    for (const auto& v : before) beforeById.emplace(v.id, &v);

    // 1. 逐格占用互斥: 任意格最多被一辆车占用 (无碰撞)
    std::map<Cell, int> claim;
    for (const auto& r : report.reservations)
        for (const auto& c : r.cells) {
            const auto [it, inserted] = claim.emplace(c, r.vehicle_id);
            if (!inserted)
                return "collision: cell " + cellStr(c) + " claimed by both #" +
                       std::to_string(it->second) + " and #" + std::to_string(r.vehicle_id);
        }

    // 2. 由 before + 决策独立重算期望状态
    std::map<int, VehicleSnapshot> expected;
    std::set<int> decided;
    for (const auto& r : report.reservations) {
        const auto it = beforeById.find(r.vehicle_id);
        if (it == beforeById.end())
            return "reservation for unknown vehicle #" + std::to_string(r.vehicle_id);
        const Vehicle& v = *it->second;
        if (!decided.insert(v.id).second)
            return "vehicle #" + std::to_string(v.id) + " arbitrated twice";
        if (v.atDestination())
            return "vehicle #" + std::to_string(v.id) + " arbitrated despite being at destination";

        VehicleSnapshot e;
        e.id = v.id;
        if (r.moved) {
            if (r.cells.size() != 2 || r.cells[0] != v.route[v.pos] || r.cells[1] != v.route[v.pos + 1])
                return "vehicle #" + std::to_string(v.id) + ": approved claim is not {cur, next}";
            e.pos = v.pos + 1;
            e.wait = 0;
            e.total_wait = v.total_wait;
            e.arrived = (e.pos + 1 >= v.route.size());
        } else {
            if (r.cells.size() != 1 || r.cells[0] != v.route[v.pos])
                return "vehicle #" + std::to_string(v.id) + ": rejected claim is not {cur}";
            e.pos = v.pos;
            e.wait = v.wait + 1;
            e.total_wait = v.total_wait + 1;
            e.arrived = false;
        }
        expected.emplace(v.id, e);
    }
    for (const int id : report.arrived) {
        const auto it = beforeById.find(id);
        if (it == beforeById.end())
            return "arrival of unknown vehicle #" + std::to_string(id);
        if (!it->second->atDestination())
            return "vehicle #" + std::to_string(id) + " arrived without reaching destination";
        if (decided.count(id))
            return "vehicle #" + std::to_string(id) + " both arrived and arbitrated";
        const Vehicle& v = *it->second;
        expected.emplace(id, VehicleSnapshot{id, v.pos, v.wait, v.total_wait, true});
    }
    for (const auto& v : before)
        if (!expected.count(v.id))
            return "vehicle #" + std::to_string(v.id) + " missing from tick report";

    // 3. 重算结果与报告快照比对 (等待累加核验)
    if (report.after.size() != expected.size())
        return "after-state size mismatch";
    for (const auto& s : report.after) {
        const auto it = expected.find(s.id);
        if (it == expected.end())
            return "after-state for unknown vehicle #" + std::to_string(s.id);
        const VehicleSnapshot& e = it->second;
        if (s.pos != e.pos || s.wait != e.wait || s.total_wait != e.total_wait || s.arrived != e.arrived)
            return "vehicle #" + std::to_string(s.id) + ": state mismatch (pos/wait/total_wait/arrived)";
    }

    // 4. tick 结束后占位唯一
    std::map<Cell, int> finalOcc;
    for (const auto& s : report.after) {
        if (s.arrived) continue;
        const Cell c = beforeById.at(s.id)->route[s.pos];
        const auto [it, inserted] = finalOcc.emplace(c, s.id);
        if (!inserted)
            return "collision after tick: cell " + cellStr(c) + " occupied by both #" +
                   std::to_string(it->second) + " and #" + std::to_string(s.id);
    }

    // 5. 拒绝理由必须指向真实冲突, 且被拒车辆确实未通行
    for (const auto& rej : report.rejections) {
        const auto claimIt = claim.find(rej.conflict_cell);
        const bool claimedByOther = claimIt != claim.end() && claimIt->second == rej.conflict_with;
        const auto otherIt = beforeById.find(rej.conflict_with);
        const bool occupiedByOther = otherIt != beforeById.end() &&
                                     otherIt->second->cell() == rej.conflict_cell;
        if (!claimedByOther && !occupiedByOther)
            return "rejection of #" + std::to_string(rej.vehicle_id) +
                   " references no real conflict at " + cellStr(rej.conflict_cell);
        const auto expIt = expected.find(rej.vehicle_id);
        if (expIt == expected.end() || expIt->second.pos != beforeById.at(rej.vehicle_id)->pos)
            return "rejected vehicle #" + std::to_string(rej.vehicle_id) + " actually moved";
    }
    return {};
}

} // namespace trafficsim
