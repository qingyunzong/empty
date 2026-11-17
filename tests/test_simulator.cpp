#include "dlks/formal/discrete_event_simulator.hpp"

#include <cassert>
#include <cstdlib>
#include <cstddef>
#include <cstdint>
#include <iostream>
#include <string>
#include <unordered_map>
#include <vector>

using dlks::formal::DiscreteEventSimulator;
using dlks::formal::SimConfig;
using dlks::formal::SimNode;
using dlks::formal::SimReport;
using dlks::formal::SimTransportConfig;

namespace {

void require(bool condition, const std::string& message) {
    if (!condition) {
        std::cerr << "FAIL: " << message << '\n';
        std::abort();
    }
}

void requireClean(const SimReport& report) {
    require(report.ok, "report not ok");
    require(report.violations.empty(),
            "unexpected violations: " +
                (report.violations.empty() ? "" : report.violations.front()));
    require(report.allocator_live_bytes_end == 0,
            "live bytes leaked at end");
    require(report.allocs == report.frees, "alloc/free mismatch");
}

// 线性链 8 个节点，每节点一个参数，验证无提前通信且发射不早于就绪时刻。
void test_linear_chain() {
    std::vector<SimNode> nodes;
    std::unordered_map<std::uint64_t, std::size_t> bytes;
    for (std::size_t i = 0; i < 8; ++i) {
        nodes.push_back(SimNode{
            .params = {static_cast<std::uint64_t>(i + 1)},
            .predecessors = i == 0 ? std::vector<std::size_t>{}
                                   : std::vector<std::size_t>{i - 1},
            .compute_cost = 3});
        bytes[i + 1] = 100;
    }
    SimConfig config{
        .scheduler = {.bucket_capacity_bytes = 300,
                      .max_inflight_buckets = 2},
        .transport = {.latency_units = 2, .bytes_per_unit = 50.0}};

    DiscreteEventSimulator simulator(std::move(nodes), std::move(bytes),
                                     config);
    SimReport report = simulator.run();
    requireClean(report);
    require(!report.launches.empty(), "no launches recorded");
    for (const auto& launch : report.launches) {
        double bound = 0.0;
        for (auto param_id : launch.param_ids) {
            bound = std::max(bound,
                             report.param_ready_lower_bound.at(param_id));
        }
        require(launch.launch_time + 1e-9 >= bound,
                "launch before ready bound");
    }
    require(report.max_inflight_observed <= 2, "inflight window violated");
}

// fork-join 拓扑 + 共享参数：参数 5 出现在两个节点，只归集一次。
void test_fork_join_shared() {
    std::vector<SimNode> nodes = {
        SimNode{.params = {1}, .predecessors = {}, .compute_cost = 2},  // 0
        SimNode{.params = {2}, .predecessors = {0}, .compute_cost = 2},  // 1
        SimNode{.params = {5}, .predecessors = {0}, .compute_cost = 4},  // 2 共享
        SimNode{.params = {3}, .predecessors = {1}, .compute_cost = 2},  // 3
        SimNode{.params = {5, 4}, .predecessors = {2, 3}, .compute_cost = 2},  // 4 共享
        SimNode{.params = {6}, .predecessors = {4}, .compute_cost = 2}}; // 5
    std::unordered_map<std::uint64_t, std::size_t> bytes = {
        {1, 100}, {2, 100}, {3, 100}, {4, 100}, {5, 200}, {6, 100}};
    SimConfig config{
        .scheduler = {.bucket_capacity_bytes = 400,
                      .max_inflight_buckets = 2},
        .transport = {.latency_units = 1, .bytes_per_unit = 100.0}};

    DiscreteEventSimulator simulator(std::move(nodes), std::move(bytes),
                                     config);
    SimReport report = simulator.run();
    requireClean(report);

    std::size_t occurrences_of_5 = 0;
    std::size_t unique_bytes = 0;
    for (const auto& launch : report.launches) {
        for (auto param_id : launch.param_ids) {
            if (param_id == 5) {
                ++occurrences_of_5;
            }
        }
        unique_bytes += launch.bytes;
    }
    require(occurrences_of_5 == 1, "shared param collected more than once");
    require(unique_bytes == 700,
            "unique bytes mismatch (expected 100*5 + 200 = 700)");

    // 共享参数 5 的就绪下界由两个贡献节点的最晚完成时刻决定。
    const double bound5 = report.param_ready_lower_bound.at(5);
    require(bound5 == 8.0, "shared param ready bound wrong");
    for (const auto& launch : report.launches) {
        bool contains5 = false;
        for (auto param_id : launch.param_ids) {
            contains5 = contains5 || param_id == 5;
        }
        if (contains5) {
            require(launch.launch_time + 1e-9 >= bound5,
                    "bucket with shared param launched early");
        }
    }
}

// 运行中途取消：在途请求全部中止，缓冲全部归还，无泄漏。
void test_cancel_midrun() {
    std::vector<SimNode> nodes;
    std::unordered_map<std::uint64_t, std::size_t> bytes;
    for (std::size_t i = 0; i < 12; ++i) {
        nodes.push_back(SimNode{
            .params = {static_cast<std::uint64_t>(i + 1)},
            .predecessors = i == 0 ? std::vector<std::size_t>{}
                                   : std::vector<std::size_t>{i - 1},
            .compute_cost = 10});
        bytes[i + 1] = 100;
    }
    SimConfig config{
        .scheduler = {.bucket_capacity_bytes = 100,
                      .max_inflight_buckets = 2},
        .transport = {.latency_units = 50, .bytes_per_unit = 10.0},
        .cancel_at = 25.0};

    DiscreteEventSimulator simulator(std::move(nodes), std::move(bytes),
                                     config);
    SimReport report = simulator.run();
    require(report.cancelled, "cancel not observed");
    require(report.allocator_live_bytes_end == 0,
            "buffers leaked after cancel");
    require(report.allocs == report.frees, "alloc/free mismatch after cancel");
    bool any_aborted = false;
    for (const auto& launch : report.launches) {
        any_aborted = any_aborted || launch.aborted;
    }
    require(any_aborted, "no in-flight launch was aborted");
}

// 峰值内存受限：小窗口 + 大参数，峰值严格受窗口 × 最大桶字节约束。
void test_peak_memory_bound() {
    std::vector<SimNode> nodes;
    std::unordered_map<std::uint64_t, std::size_t> bytes;
    for (std::size_t i = 0; i < 10; ++i) {
        nodes.push_back(SimNode{
            .params = {static_cast<std::uint64_t>(i + 1)},
            .predecessors = i == 0 ? std::vector<std::size_t>{}
                                   : std::vector<std::size_t>{i - 1},
            .compute_cost = 1});
        bytes[i + 1] = 100;
    }
    SimConfig config{
        .scheduler = {.bucket_capacity_bytes = 100,
                      .max_inflight_buckets = 3},
        .transport = {.latency_units = 5, .bytes_per_unit = 25.0}};

    DiscreteEventSimulator simulator(std::move(nodes), std::move(bytes),
                                     config);
    SimReport report = simulator.run();
    requireClean(report);
    require(report.allocator_peak_bytes <= 400,
            "peak memory exceeded (window + 1) * bucket bytes");
    require(report.max_inflight_observed <= 3, "inflight window exceeded");
}

// 宽 DAG 的通信/计算重叠：存在发射时刻落在某节点计算窗口内部的桶。
void test_overlap_with_backward() {
    std::vector<SimNode> nodes;
    std::unordered_map<std::uint64_t, std::size_t> bytes;
    for (std::size_t i = 0; i < 16; ++i) {
        nodes.push_back(SimNode{
            .params = {static_cast<std::uint64_t>(i + 1)},
            .predecessors = i == 0 ? std::vector<std::size_t>{}
                                   : std::vector<std::size_t>{i - 1},
            .compute_cost = 2});
        bytes[i + 1] = 100;
    }
    SimConfig config{
        .scheduler = {.bucket_capacity_bytes = 200,
                      .max_inflight_buckets = 4},
        .transport = {.latency_units = 20, .bytes_per_unit = 5.0}};

    DiscreteEventSimulator simulator(std::move(nodes), std::move(bytes),
                                     config);
    SimReport report = simulator.run();
    requireClean(report);

    bool overlapped = false;
    for (const auto& launch : report.launches) {
        // 反向总计算窗口为 [0, 32]；首个桶在 t=4 就绪发射，
        // 其通信完成时刻晚于总计算窗口，即与后续反向计算重叠。
        if (launch.launch_time < 32.0 && launch.finish_time > launch.launch_time) {
            overlapped = true;
        }
    }
    require(overlapped, "no communication overlapped backward compute");
    require(report.launches.size() == 8, "expected 8 two-param buckets");
}

// 环图必须被拒绝，避免就绪下界计算无限等待。
void test_cycle_rejected() {
    std::vector<SimNode> nodes = {
        SimNode{.params = {1}, .predecessors = {1}},
        SimNode{.params = {2}, .predecessors = {0}}};
    std::unordered_map<std::uint64_t, std::size_t> bytes = {{1, 10},
                                                            {2, 10}};
    SimConfig config;
    bool threw = false;
    try {
        DiscreteEventSimulator simulator(std::move(nodes), std::move(bytes),
                                         config);
    } catch (const std::invalid_argument&) {
        threw = true;
    }
    require(threw, "cyclic graph was not rejected");
}

}  // namespace

int main() {
    test_linear_chain();
    test_fork_join_shared();
    test_cancel_midrun();
    test_peak_memory_bound();
    test_overlap_with_backward();
    test_cycle_rejected();
    std::cout << "simulator tests: all 6 cases passed\n";
    return 0;
}
