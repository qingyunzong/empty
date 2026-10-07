#pragma once

#include <cstddef>
#include <string>
#include <vector>

namespace trafficsim {

struct Cell {
    int x = 0;
    int y = 0;
    friend auto operator<=>(const Cell&, const Cell&) = default;
};

struct Vehicle {
    int id = 0;
    bool emergency = false;
    std::vector<Cell> route;   // 依次经过的格, 相邻格必须曼哈顿相邻
    std::size_t pos = 0;       // 当前所在 route 下标
    int wait = 0;              // 连续等待 tick 数 (仲裁依据)
    long long total_wait = 0;  // 累计等待 tick 数
    bool arrived = false;

    const Cell& cell() const { return route[pos]; }
    bool atDestination() const { return pos + 1 >= route.size(); }
};

// 车辆 <-> 占用格 配对
struct Reservation {
    int vehicle_id = 0;
    std::vector<Cell> cells;   // 通行: {当前格, 目标格}; 被拒: {当前格}
    bool moved = false;
};

struct Rejection {
    int vehicle_id = 0;
    Cell conflict_cell;
    int conflict_with = -1;    // 冲突对方车辆 id
    std::string reason;
};

struct VehicleSnapshot {
    int id = 0;
    std::size_t pos = 0;
    int wait = 0;
    long long total_wait = 0;
    bool arrived = false;
};

struct TickReport {
    int tick_index = 0;
    std::vector<Reservation> reservations;  // 按仲裁顺序排列
    std::vector<Rejection> rejections;
    std::vector<int> arrived;
    std::vector<VehicleSnapshot> after;     // 本 tick 结束后全员状态
};

class Simulator {
public:
    // 路线为空、相邻格不相邻、或起点与其他车辆重叠时抛 std::invalid_argument
    void addVehicle(Vehicle v);
    [[nodiscard]] TickReport tick();
    [[nodiscard]] bool done() const { return vehicles_.empty(); }
    [[nodiscard]] const std::vector<Vehicle>& vehicles() const { return vehicles_; }
    [[nodiscard]] int tickCount() const { return tick_count_; }

private:
    std::vector<Vehicle> vehicles_;
    int tick_count_ = 0;
};

// 逐格占用参考核验: 由 before 状态与报告中的决策独立重算,
// 检查占用格互斥(无碰撞)、通行/被拒配对合法、等待累加正确、拒绝理由属实。
// 返回空串表示通过, 否则返回首个违规描述。
[[nodiscard]] std::string verifyTick(const std::vector<Vehicle>& before,
                                     const TickReport& report);

} // namespace trafficsim
