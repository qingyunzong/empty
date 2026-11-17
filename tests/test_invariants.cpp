#include "dlks/formal/gradient_bucket_scheduler.hpp"

#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <iostream>
#include <memory>
#include <unordered_map>
#include <vector>

#include "dlks/formal/discrete_event_simulator.hpp"

using dlks::formal::Buffer;
using dlks::formal::BucketInfo;
using dlks::formal::DiscreteEventSimulator;
using dlks::formal::GradientBucketScheduler;
using dlks::formal::SimConfig;
using dlks::formal::SimNode;
using dlks::formal::SimReport;
using dlks::formal::SchedulerConfig;
using dlks::formal::TrackingMallocAllocator;

namespace {

#define CHECK(condition)                                                \
    do {                                                                \
        if (!(condition)) {                                             \
            std::cerr << "CHECK failed: " #condition " at " << __FILE__ \
                      << ':' << __LINE__ << '\n';                       \
            std::abort();                                               \
        }                                                               \
    } while (false)

// 负向测试：篡改一份干净报告，证明不变量校验器能真正捕获
// “提前通信”和“重复字节”，而不是对任何输入都放行。
void test_early_communication_detected() {
    // 构造两节点链：参数 2 的就绪下界为 t=4。
    std::vector<SimNode> nodes = {
        SimNode{.params = {1}, .predecessors = {}, .compute_cost = 2},
        SimNode{.params = {2},
                .predecessors = {0},
                .compute_cost = 2}};
    std::unordered_map<std::uint64_t, std::size_t> bytes = {{1, 100},
                                                            {2, 100}};
    SimConfig config{
        .scheduler = {.bucket_capacity_bytes = 200,
                      .max_inflight_buckets = 2},
        .transport = {.latency_units = 1, .bytes_per_unit = 100.0}};

    DiscreteEventSimulator simulator(nodes, bytes, config);
    SimReport report = simulator.run();
    CHECK(report.ok);

    for (auto& launch : report.launches) {
        for (auto param_id : launch.param_ids) {
            if (param_id == 2) {
                launch.launch_time = 0.0;  // 早于就绪下界 t=4
            }
        }
    }
    report.ok = true;
    report.violations.clear();
    simulator.audit(report);
    CHECK(!report.ok);
    bool caught_early = false;
    for (const auto& message : report.violations) {
        caught_early =
            caught_early || message.find("EARLY COMMUNICATION") !=
                                std::string::npos;
    }
    CHECK(caught_early);
}

void test_duplicate_bytes_detected() {
    std::vector<SimNode> nodes = {
        SimNode{.params = {1}, .predecessors = {}, .compute_cost = 1},
        SimNode{.params = {2},
                .predecessors = {0},
                .compute_cost = 1}};
    std::unordered_map<std::uint64_t, std::size_t> bytes = {{1, 100},
                                                            {2, 100}};
    SimConfig config{
        .scheduler = {.bucket_capacity_bytes = 100,
                      .max_inflight_buckets = 2},
        .transport = {.latency_units = 1, .bytes_per_unit = 100.0}};

    DiscreteEventSimulator simulator(nodes, bytes, config);
    SimReport report = simulator.run();
    CHECK(report.ok);

    // 注入一个重复归集参数 1 的伪造桶，并把字节数翻倍。
    auto duplicated = report.launches.front();
    duplicated.bucket_id = 999;
    duplicated.param_ids = {1};
    duplicated.bytes = 100;
    report.launches.push_back(duplicated);
    report.ok = true;
    report.violations.clear();
    simulator.audit(report);
    CHECK(!report.ok);
    bool caught_dup = false;
    for (const auto& message : report.violations) {
        caught_dup = caught_dup ||
                     message.find("appears in 2 launched buckets") !=
                         std::string::npos;
    }
    CHECK(caught_dup);
}

// 直接验证调度器在“重复发射同一参数”不可能发生：
// 桶一旦 launched 就不会再次进入发射集合。
void test_no_duplicate_launch_at_scheduler() {
    std::size_t launches = 0;
    std::unordered_map<std::uint64_t, std::size_t> bucket_seen;
    std::vector<std::uint64_t> request_ids;
    GradientBucketScheduler scheduler(
        SchedulerConfig{.bucket_capacity_bytes = 100,
                        .max_inflight_buckets = 1},
        [&](std::uint64_t request_id, Buffer, const BucketInfo& bucket) {
            ++launches;
            ++bucket_seen[bucket.bucket_id];
            request_ids.push_back(request_id);
        },
        std::make_shared<TrackingMallocAllocator>());

    for (std::uint64_t p = 1; p <= 4; ++p) {
        scheduler.register_tensor(p, 100);
    }
    scheduler.flush();
    for (std::uint64_t p = 1; p <= 4; ++p) {
        scheduler.mark_ready(p);
    }
    std::size_t consumed = 0;
    while (scheduler.completed_count() < 4) {
        scheduler.complete(request_ids.at(consumed++));
    }
    CHECK(consumed == 4);
    CHECK(launches == 4);
    for (const auto& [bucket_id, count] : bucket_seen) {
        CHECK(count == 1);
    }
}

// 内存超限检测：窗口 1 时峰值不得超过单桶字节的过渡上界。
void test_memory_bound_enforced() {
    std::vector<SimNode> nodes;
    std::unordered_map<std::uint64_t, std::size_t> bytes;
    for (std::size_t i = 0; i < 5; ++i) {
        nodes.push_back(SimNode{
            .params = {static_cast<std::uint64_t>(i + 1)},
            .predecessors =
                i == 0 ? std::vector<std::size_t>{}
                       : std::vector<std::size_t>{i - 1},
            .compute_cost = 1});
        bytes[i + 1] = 100;
    }
    SimConfig config{
        .scheduler = {.bucket_capacity_bytes = 100,
                      .max_inflight_buckets = 1},
        .transport = {.latency_units = 1, .bytes_per_unit = 50.0}};
    SimReport report =
        DiscreteEventSimulator(std::move(nodes), std::move(bytes), config)
            .run();
    CHECK(report.ok);
    CHECK(report.max_inflight_observed <= 1);
    CHECK(report.allocator_peak_bytes <= 200);  // (窗口 1 + 1) × 100
    CHECK(report.allocator_live_bytes_end == 0);
}

}  // namespace

int main() {
    test_early_communication_detected();
    test_duplicate_bytes_detected();
    test_no_duplicate_launch_at_scheduler();
    test_memory_bound_enforced();
    std::cout << "invariant tests: all 4 cases passed\n";
    return 0;
}
