#pragma once

// gatesim: 事件驱动门级仿真器
// 语义（离散 tick，整数延迟）:
//   1. 外部输入在 tick 开始时施加（同 tick 先输入）。
//   2. 零延迟门在同一 tick 内按 delta 轮迭代收敛。
//   3. 延迟 d>=1 的门：期望输出变化时在 t+d 调度事件，携带新代际号；
//      旧代事件出队时被跳过，不生效。
//   4. 预定在 tick t 触发的事件即使输入在 t 变化也照常触发
//      （tick t 的输入只取消触发时间 > t 的事件）。
//      因此宽度 w >= d 的脉冲通过，w < d 的脉冲被惯性取消。
//   5. tick 内顺序: 输入 -> 到期事件触发 -> 零延迟 delta 收敛 -> 重调度。

#include <cstdint>
#include <map>
#include <optional>
#include <string>
#include <vector>

namespace gatesim {

enum class Logic : std::uint8_t { L0 = 0, L1 = 1 };

char to_char(Logic v);

enum class GateKind { Buf, Not, And, Or, Nand, Nor, Xor };

Logic eval_gate(GateKind kind, const std::vector<Logic>& inputs);

struct ChangeRecord {
    std::uint64_t time;
    int delta;
    std::size_t node;
    Logic old_value;
    Logic new_value;
    std::string reason;
};

struct CancelRecord {
    std::uint64_t time;
    std::size_t gate;
    Logic cancelled_value;
    std::uint64_t was_fire_time;
    std::string reason;
};

struct StaleRecord {
    std::uint64_t time;
    std::size_t gate;
    std::uint64_t event_gen;
    std::uint64_t current_gen;
    std::string reason;
};

class Simulator {
public:
    std::size_t add_node(std::string name, Logic init = Logic::L0);
    std::size_t add_gate(std::string name, GateKind kind,
                         std::vector<std::size_t> inputs, std::size_t output,
                         int delay);
    void add_stimulus(std::uint64_t time, std::size_t node, Logic value);

    // 仿真 tick [0, ticks)。只允许调用一次。
    void run(std::uint64_t ticks);

    [[nodiscard]] std::size_t node_count() const { return node_names_.size(); }
    [[nodiscard]] const std::vector<std::string>& node_names() const { return node_names_; }
    [[nodiscard]] std::size_t gate_count() const { return gates_.size(); }
    [[nodiscard]] const std::string& gate_name(std::size_t g) const { return gates_[g].name; }

    [[nodiscard]] const std::vector<ChangeRecord>& changes() const { return changes_; }
    [[nodiscard]] const std::vector<CancelRecord>& cancels() const { return cancels_; }
    [[nodiscard]] const std::vector<StaleRecord>& stale_events() const { return stale_; }

    // snapshots_[t][node] = tick t 结束时（所有 delta 轮收敛后）的值
    [[nodiscard]] const std::vector<std::vector<Logic>>& snapshots() const { return snapshots_; }

private:
    struct Gate {
        std::string name;
        GateKind kind;
        std::vector<std::size_t> inputs;
        std::size_t output;
        int delay;  // 0 => delta 延迟
        std::uint64_t gen = 0;
        struct Pending {
            std::uint64_t fire_time;
            Logic value;
            std::uint64_t gen;
        };
        std::optional<Pending> pending;
    };

    struct QueuedEvent {
        std::uint64_t time;
        std::uint64_t seq;
        std::size_t gate;
        std::uint64_t gen;
        Logic value;
    };

    void set_node(std::size_t node, Logic v, std::uint64_t t, std::string reason);
    void settle_delta(std::uint64_t t);
    void reconcile(std::size_t gate, std::uint64_t t);
    Logic desired(const Gate& g) const;

    std::vector<std::string> node_names_;
    std::vector<Logic> node_values_;
    std::vector<Gate> gates_;
    std::vector<std::vector<std::size_t>> fanout_;
    std::vector<int> driver_of_;  // node -> gate index or -1
    std::map<std::uint64_t, std::vector<std::pair<std::size_t, Logic>>> stimuli_;

    std::vector<QueuedEvent> queue_heap_;  // 手动最小堆（按 time, seq）
    std::uint64_t next_seq_ = 0;

    std::vector<char> in_zero_work_;
    std::vector<char> in_touched_;
    std::vector<std::size_t> zero_work_;
    std::vector<std::size_t> touched_;
    int current_delta_ = 0;

    std::vector<ChangeRecord> changes_;
    std::vector<CancelRecord> cancels_;
    std::vector<StaleRecord> stale_;
    std::vector<std::vector<Logic>> snapshots_;
};

// 波形（每 tick 末值）与事件记录（含原因）的文本输出
std::string format_waveform(const Simulator& sim);
std::string format_records(const Simulator& sim);

}  // namespace gatesim
