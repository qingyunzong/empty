#pragma once

// 独立逐 tick 参考模型：不用事件队列，直接按文档语义逐 tick 推进，
// 用于与 gatesim::Simulator 的事件驱动实现交叉核对。
// 语义与 Simulator 相同：
//   每个 tick: 施加输入 -> 触发到期事件 -> 零延迟收敛 -> 延迟门重调度。
//   到期事件在本 tick 输入变化后仍触发（宽度 >= 延迟的脉冲通过）。

#include <optional>
#include <vector>
#include "gatesim.hpp"

namespace refmodel {

struct Circuit {
    std::vector<gatesim::Logic> init;              // 每节点初始值
    std::vector<gatesim::GateKind> kinds;          // 每门
    std::vector<std::vector<std::size_t>> inputs;  // 每门输入节点
    std::vector<std::size_t> outputs;              // 每门输出节点
    std::vector<int> delays;                       // 每门延迟（0 = delta）
};

using Stimuli = std::vector<std::vector<std::pair<std::size_t, gatesim::Logic>>>;

inline std::vector<std::vector<gatesim::Logic>> run(const Circuit& c,
                                                    const Stimuli& stimuli,
                                                    std::uint64_t ticks) {
    using gatesim::Logic;
    std::vector<Logic> values = c.init;
    struct Pend {
        std::uint64_t fire;
        Logic value;
    };
    std::vector<std::optional<Pend>> pend(c.kinds.size());
    std::vector<std::vector<Logic>> snaps;

    auto eval = [&](std::size_t g) {
        std::vector<Logic> ins;
        for (std::size_t i : c.inputs[g]) ins.push_back(values[i]);
        return gatesim::eval_gate(c.kinds[g], ins);
    };

    for (std::uint64_t t = 0; t < ticks; ++t) {
        // 1. 输入
        if (t < stimuli.size())
            for (const auto& [n, v] : stimuli[t]) values[n] = v;
        // 2. 到期事件触发
        for (std::size_t g = 0; g < c.kinds.size(); ++g)
            if (pend[g] && pend[g]->fire == t) {
                values[c.outputs[g]] = pend[g]->value;
                pend[g].reset();
            }
        // 3. 零延迟门收敛（delta 轮）
        bool changed = true;
        while (changed) {
            changed = false;
            for (std::size_t g = 0; g < c.kinds.size(); ++g) {
                if (c.delays[g] != 0) continue;
                Logic d = eval(g);
                if (d != values[c.outputs[g]]) {
                    values[c.outputs[g]] = d;
                    changed = true;
                }
            }
        }
        // 4. 延迟门重调度（惯性：回到当前值则取消）
        for (std::size_t g = 0; g < c.kinds.size(); ++g) {
            if (c.delays[g] == 0) continue;
            Logic d = eval(g);
            if (d == values[c.outputs[g]])
                pend[g].reset();
            else if (!pend[g] || pend[g]->value != d)
                pend[g] = Pend{t + static_cast<std::uint64_t>(c.delays[g]), d};
        }
        snaps.push_back(values);
    }
    return snaps;
}

}  // namespace refmodel
