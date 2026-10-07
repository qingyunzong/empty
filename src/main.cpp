#include "trafficsim/simulator.hpp"

#include <iostream>
#include <string>

using namespace trafficsim;

namespace {

std::string cellStr(const Cell& c) {
    return "(" + std::to_string(c.x) + "," + std::to_string(c.y) + ")";
}

std::string cellsStr(const std::vector<Cell>& cells) {
    std::string out = "{";
    for (std::size_t i = 0; i < cells.size(); ++i) {
        if (i) out += ",";
        out += cellStr(cells[i]);
    }
    return out + "}";
}

} // namespace

int main() {
    Simulator sim;
    // 十字路口: 东西向车流与南北向车流在 (3,3) 交汇
    sim.addVehicle({.id = 1, .emergency = false,
                    .route = {{0, 3}, {1, 3}, {2, 3}, {3, 3}, {4, 3}, {5, 3}, {6, 3}}});
    sim.addVehicle({.id = 2, .emergency = false,
                    .route = {{1, 3}, {2, 3}, {3, 3}, {4, 3}, {5, 3}, {6, 3}}});
    sim.addVehicle({.id = 3, .emergency = true,
                    .route = {{3, 0}, {3, 1}, {3, 2}, {3, 3}, {3, 4}, {3, 5}, {3, 6}}});
    sim.addVehicle({.id = 4, .emergency = false,
                    .route = {{3, 1}, {3, 2}, {3, 3}, {3, 4}, {3, 5}, {3, 6}}});
    sim.addVehicle({.id = 5, .emergency = false,
                    .route = {{5, 6}, {5, 5}, {5, 4}, {5, 3}, {5, 2}, {5, 1}, {5, 0}}});

    constexpr int kMaxTicks = 40;
    while (!sim.done() && sim.tickCount() < kMaxTicks) {
        const auto before = sim.vehicles();
        const TickReport report = sim.tick();

        std::cout << "tick " << report.tick_index << "\n";
        for (const auto& r : report.reservations) {
            std::cout << "  配对 #" << r.vehicle_id << " -> " << cellsStr(r.cells)
                      << (r.moved ? "  [通行]" : "  [等待]") << "\n";
        }
        for (const auto& rej : report.rejections) {
            const auto* v = [&] {
                for (const auto& s : report.after)
                    if (s.id == rej.vehicle_id) return &s;
                return static_cast<const VehicleSnapshot*>(nullptr);
            }();
            std::cout << "  拒绝 #" << rej.vehicle_id << " (等待=" << v->wait
                      << "): " << rej.reason << "\n";
        }
        for (const int id : report.arrived)
            std::cout << "  到达 #" << id << "\n";

        const std::string err = verifyTick(before, report);
        std::cout << "  核验: " << (err.empty() ? "OK (逐格占用无碰撞, 等待累加正确)" : err) << "\n";
        if (!err.empty()) return 1;
    }

    std::cout << "\n仿真结束, 共 " << sim.tickCount() << " tick\n";
    return 0;
}
