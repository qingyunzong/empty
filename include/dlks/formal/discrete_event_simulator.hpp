#pragma once

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <memory>
#include <queue>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

#include "dlks/formal/gradient_bucket_scheduler.hpp"

namespace dlks::formal {

// 反向计算 DAG 中的一个计算节点。
//   - params：该节点梯度累加完成时标记就绪的参数；共享参数可出现在多个节点。
//   - predecessors：直接前驱的节点下标，前驱全部完成后该节点才能开始计算。
//   - compute_cost：该节点占用的离散时间单位。
struct SimNode {
    std::vector<std::uint64_t> params;
    std::vector<std::size_t> predecessors;
    std::size_t compute_cost = 1;
};

// 模拟通信层：单次 all-reduce 耗时与传输字节的线性模型。
struct SimTransportConfig {
    std::size_t latency_units = 2;
    double bytes_per_unit = 64.0;
};

struct SimConfig {
    SchedulerConfig scheduler{};
    SimTransportConfig transport{};
    // 若为有限值，在该时刻注入 cancel 事件。
    double cancel_at = std::numeric_limits<double>::infinity();
};

struct LaunchRecord {
    std::uint64_t request_id;
    std::uint64_t bucket_id;
    std::size_t bytes;
    std::vector<std::uint64_t> param_ids;
    double launch_time;
    double finish_time;
    bool aborted = false;
};

struct SimReport {
    bool ok = true;
    std::vector<std::string> violations;
    std::vector<LaunchRecord> launches;
    double last_event_time = 0.0;
    std::size_t max_inflight_observed = 0;
    std::size_t allocator_peak_bytes = 0;
    std::size_t allocator_live_bytes_end = 0;
    std::size_t allocs = 0;
    std::size_t frees = 0;
    std::size_t scheduled_total_bytes = 0;
    std::size_t scheduled_max_bucket_bytes = 0;
    bool cancelled = false;
    std::unordered_map<std::uint64_t, double> param_ready_time;
    std::unordered_map<std::uint64_t, double> param_ready_lower_bound;
};

namespace detail {

struct SimEvent {
    double time;
    std::uint64_t seq;
    // 0=节点计算完成 1=通信完成 2=取消
    int kind;
    std::size_t node = 0;
    std::uint64_t request_id = 0;

    bool operator>(const SimEvent& other) const {
        if (time != other.time) {
            return time > other.time;
        }
        return seq > other.seq;
    }
};

}  // namespace detail

// 离散事件模拟器：用事件队列驱动一个真实的 GradientBucketScheduler，
// 模拟反向计算 DAG 与 all-reduce 传输，并在运行后对照 DAG 校验不变量。
class DiscreteEventSimulator {
public:
    // param_bytes：参数 id -> 字节数（共享参数只出现一次）。
    DiscreteEventSimulator(std::vector<SimNode> nodes,
                           std::unordered_map<std::uint64_t, std::size_t>
                               param_bytes,
                           SimConfig config)
        : nodes_(std::move(nodes)),
          param_bytes_(std::move(param_bytes)),
          config_(std::move(config)) {
        buildTopology();
        computeReadyLowerBounds();
    }

    SimReport run();

    // 对一份（可能被外部篡改的）报告重新执行全部不变量校验，
    // 便于测试与外部审计复用同一套判定逻辑。
    void audit(SimReport& report);

private:
    struct ParamMeta {
        std::size_t bytes;
        std::size_t contrib_count;
    };

    void buildTopology();
    void computeReadyLowerBounds();
    void recordReadyTime(std::uint64_t param_id, double time);
    void verify(SimReport& report,
                const std::unordered_map<std::uint64_t, std::size_t>&
                    pending_contrib,
                const std::unordered_set<std::uint64_t>& held_buffers);

    std::vector<SimNode> nodes_;
    std::unordered_map<std::uint64_t, std::size_t> param_bytes_;
    SimConfig config_;
    std::vector<std::vector<std::size_t>> successors_;
    std::unordered_map<std::uint64_t, double> param_ready_time_;
    std::unordered_map<std::uint64_t, double> param_ready_lower_bound_;
    std::unique_ptr<GradientBucketScheduler> scheduler_;
    std::shared_ptr<TrackingMallocAllocator> allocator_;
    std::vector<LaunchRecord> launches_;
    double current_time_ = 0.0;
};

inline void DiscreteEventSimulator::buildTopology() {
    successors_.resize(nodes_.size());
    for (std::size_t i = 0; i < nodes_.size(); ++i) {
        for (std::size_t pred : nodes_[i].predecessors) {
            if (pred >= nodes_.size()) {
                throw std::invalid_argument("predecessor index out of range");
            }
            successors_[pred].push_back(i);
        }
        for (std::uint64_t param_id : nodes_[i].params) {
            if (!param_bytes_.count(param_id)) {
                throw std::invalid_argument(
                    "node references param without byte specification");
            }
        }
    }
}

// 由 DAG 拓扑计算每个参数最早可能就绪时刻（最长前驱路径的节点完成时刻）。
// 调度器在该时刻之前发射包含该参数的桶即构成“提前通信”。
inline void DiscreteEventSimulator::computeReadyLowerBounds() {
    const std::size_t node_count = nodes_.size();
    std::vector<std::size_t> indegree(node_count);
    std::vector<double> earliest_finish(node_count, 0.0);
    std::vector<std::size_t> stack;
    for (std::size_t i = 0; i < node_count; ++i) {
        indegree[i] = nodes_[i].predecessors.size();
        if (indegree[i] == 0) {
            stack.push_back(i);
            earliest_finish[i] =
                static_cast<double>(nodes_[i].compute_cost);
        }
    }
    std::size_t visited = 0;
    while (!stack.empty()) {
        std::size_t i = stack.back();
        stack.pop_back();
        ++visited;
        for (std::size_t succ : successors_[i]) {
            earliest_finish[succ] = std::max(
                earliest_finish[succ],
                earliest_finish[i] +
                    static_cast<double>(nodes_[succ].compute_cost));
            if (--indegree[succ] == 0) {
                stack.push_back(succ);
            }
        }
    }
    if (visited != node_count) {
        throw std::invalid_argument("dependency graph has a cycle");
    }
    for (std::size_t i = 0; i < node_count; ++i) {
        for (std::uint64_t param_id : nodes_[i].params) {
            auto [it, inserted] =
                param_ready_lower_bound_.try_emplace(param_id, 0.0);
            it->second = std::max(it->second, earliest_finish[i]);
            (void)inserted;
        }
    }
}

inline void DiscreteEventSimulator::recordReadyTime(
    std::uint64_t param_id, double time) {
    auto [it, inserted] = param_ready_time_.try_emplace(param_id, time);
    if (!inserted) {
        it->second = std::max(it->second, time);
    }
}

inline SimReport DiscreteEventSimulator::run() {
    const std::size_t node_count = nodes_.size();
    std::vector<std::size_t> remaining(node_count);
    std::vector<char> scheduled(node_count, false);
    std::unordered_map<std::uint64_t, std::size_t> pending_contrib;
    std::unordered_map<std::uint64_t, std::size_t> contrib_count;
    for (const SimNode& node : nodes_) {
        for (std::uint64_t param_id : node.params) {
            ++contrib_count[param_id];
        }
    }
    pending_contrib = contrib_count;

    std::priority_queue<detail::SimEvent,
                        std::vector<detail::SimEvent>,
                        std::greater<detail::SimEvent>>
        queue;
    std::uint64_t seq = 0;

    SimReport report;
    std::unordered_map<std::uint64_t, std::size_t> inflight_index;
    std::unordered_set<std::uint64_t> held_buffers;

    allocator_ = std::make_shared<TrackingMallocAllocator>();
    auto abort_fn = [&](std::uint64_t request_id, const BucketInfo&) {
        // 模拟通信层在中止时立即释放自身持有的缓冲引用。
        held_buffers.erase(request_id);
    };
    auto launcher = [&](std::uint64_t request_id, Buffer buffer,
                        const BucketInfo& bucket) {
        const double now = current_time_;
        if (!buffer.valid()) {
            report.ok = false;
            report.violations.push_back("launched buffer is invalid");
        }
        held_buffers.insert(request_id);
        double ready_bound = 0.0;
        for (std::uint64_t param_id : bucket.param_ids) {
            ready_bound = std::max(
                ready_bound, param_ready_lower_bound_.at(param_id));
        }
        if (now + 1e-9 < ready_bound) {
            report.ok = false;
            report.violations.push_back(
                "EARLY COMMUNICATION: bucket " +
                std::to_string(bucket.bucket_id) + " launched at t=" +
                std::to_string(now) + " before ready bound t=" +
                std::to_string(ready_bound));
        }
        const double comm_time =
            static_cast<double>(config_.transport.latency_units) +
            static_cast<double>(bucket.bytes) /
                config_.transport.bytes_per_unit;
        LaunchRecord record{request_id,
                            bucket.bucket_id,
                            bucket.bytes,
                            bucket.param_ids,
                            now,
                            now + comm_time,
                            false};
        launches_.push_back(record);
        inflight_index.emplace(request_id, launches_.size() - 1);
        queue.push(detail::SimEvent{now + comm_time, seq++, 1, 0,
                                    request_id});
        report.max_inflight_observed = std::max(
            report.max_inflight_observed, scheduler_->inflight_count());
    };

    scheduler_ = std::make_unique<GradientBucketScheduler>(
        config_.scheduler, launcher, allocator_, abort_fn);

    for (const auto& [param_id, count] : contrib_count) {
        for (std::size_t k = 0; k < count; ++k) {
            scheduler_->register_tensor(param_id, param_bytes_.at(param_id));
        }
    }
    scheduler_->flush();

    for (std::size_t i = 0; i < node_count; ++i) {
        remaining[i] = nodes_[i].predecessors.size();
        if (remaining[i] == 0) {
            scheduled[i] = true;
            queue.push(detail::SimEvent{
                static_cast<double>(nodes_[i].compute_cost), seq++, 0, i, 0});
        }
    }
    if (std::isfinite(config_.cancel_at)) {
        queue.push(detail::SimEvent{config_.cancel_at, seq++, 2, 0, 0});
    }

    while (!queue.empty()) {
        detail::SimEvent event = queue.top();
        queue.pop();
        current_time_ = event.time;
        report.last_event_time = event.time;

        if (event.kind == 2) {
            scheduler_->cancel();
            report.cancelled = true;
            continue;
        }
        if (event.kind == 1) {
            if (scheduler_->is_cancelled()) {
                auto it = inflight_index.find(event.request_id);
                if (it != inflight_index.end()) {
                    launches_[it->second].aborted = true;
                    inflight_index.erase(it);
                }
                held_buffers.erase(event.request_id);
                continue;
            }
            if (scheduler_->complete(event.request_id)) {
                inflight_index.erase(event.request_id);
                held_buffers.erase(event.request_id);
            }
            continue;
        }

        const SimNode& node = nodes_[event.node];
        for (std::uint64_t param_id : node.params) {
            recordReadyTime(param_id, event.time);
            auto it = pending_contrib.find(param_id);
            if (it == pending_contrib.end() || it->second == 0) {
                report.ok = false;
                report.violations.push_back(
                    "ready contribution overflow for param " +
                    std::to_string(param_id));
                continue;
            }
            --it->second;
            scheduler_->mark_ready(param_id);
        }
        for (std::size_t successor : successors_[event.node]) {
            if (--remaining[successor] == 0 && !scheduled[successor]) {
                scheduled[successor] = true;
                queue.push(detail::SimEvent{
                    event.time +
                        static_cast<double>(nodes_[successor].compute_cost),
                    seq++, 0, successor, 0});
            }
        }
    }

    report.launches = launches_;
    report.param_ready_time = param_ready_time_;
    report.param_ready_lower_bound = param_ready_lower_bound_;
    report.allocator_peak_bytes = scheduler_->peak_bytes();
    report.allocator_live_bytes_end = scheduler_->live_bytes();
    report.allocs = scheduler_->allocation_count();
    report.frees = scheduler_->deallocation_count();
    report.scheduled_total_bytes = scheduler_->total_scheduled_bytes();
    report.scheduled_max_bucket_bytes =
        scheduler_->max_scheduled_bucket_bytes();
    verify(report, pending_contrib, held_buffers);
    return report;
}

inline void DiscreteEventSimulator::audit(SimReport& report) {
    const std::unordered_map<std::uint64_t, std::size_t> empty_contrib;
    const std::unordered_set<std::uint64_t> empty_held;
    verify(report, empty_contrib, empty_held);
}

inline void DiscreteEventSimulator::verify(
    SimReport& report,
    const std::unordered_map<std::uint64_t, std::size_t>& pending_contrib,
    const std::unordered_set<std::uint64_t>& held_buffers) {
    auto fail = [&](const std::string& message) {
        report.ok = false;
        report.violations.push_back(message);
    };

    for (const auto& [param_id, remaining] : pending_contrib) {
        if (remaining != 0 && !report.cancelled) {
            fail("param " + std::to_string(param_id) +
                 " did not receive all registered contributions");
        }
    }
    if (!held_buffers.empty()) {
        fail("transport still holds buffers after simulation");
    }
    if (report.allocator_live_bytes_end != 0) {
        fail("allocator live bytes non-zero at end: " +
             std::to_string(report.allocator_live_bytes_end));
    }
    if (report.allocs != report.frees) {
        fail("alloc/free count mismatch: " + std::to_string(report.allocs) +
             " vs " + std::to_string(report.frees));
    }

    // 不变量 1：无提前通信——发射时刻不早于桶内任一参数的就绪下界。
    for (const LaunchRecord& launch : report.launches) {
        double bound = 0.0;
        for (std::uint64_t param_id : launch.param_ids) {
            bound = std::max(bound,
                             report.param_ready_lower_bound.at(param_id));
        }
        if (launch.launch_time + 1e-9 < bound) {
            fail("EARLY COMMUNICATION bucket " +
                 std::to_string(launch.bucket_id));
        }
        // 实际模拟的就绪时刻也不得晚于发射时刻。
        for (std::uint64_t param_id : launch.param_ids) {
            auto it = report.param_ready_time.find(param_id);
            if (it != report.param_ready_time.end() &&
                launch.launch_time + 1e-9 < it->second) {
                fail("bucket " + std::to_string(launch.bucket_id) +
                     " launched before actual param ready time");
            }
        }
    }

    // 不变量 2：无重复字节——每个参数恰好出现在一个发射桶中；
    // 桶字节数等于成员参数字节数之和（共享参数只归集一次）。
    std::unordered_map<std::uint64_t, std::size_t> occurrences;
    std::size_t unique_bytes_launched = 0;
    for (const LaunchRecord& launch : report.launches) {
        std::unordered_set<std::uint64_t> in_bucket(
            launch.param_ids.begin(), launch.param_ids.end());
        if (in_bucket.size() != launch.param_ids.size()) {
            fail("bucket " + std::to_string(launch.bucket_id) +
                 " contains a duplicated param");
        }
        std::size_t summed = 0;
        for (std::uint64_t param_id : launch.param_ids) {
            ++occurrences[param_id];
            summed += param_bytes_.at(param_id);
        }
        if (summed != launch.bytes) {
            fail("bucket " + std::to_string(launch.bucket_id) +
                 " bytes mismatch: header " + std::to_string(launch.bytes) +
                 " vs member sum " + std::to_string(summed));
        }
        unique_bytes_launched += summed;
    }
    for (const auto& [param_id, bytes] : param_bytes_) {
        if (report.cancelled && occurrences[param_id] == 0) {
            // 取消时尚未发射的桶不参与通信，参数缺失属于预期行为。
            continue;
        }
        if (occurrences[param_id] != 1) {
            fail("param " + std::to_string(param_id) +
                 " appears in " + std::to_string(occurrences[param_id]) +
                 " launched buckets (expected 1)");
        }
        (void)bytes;
    }
    if (!report.cancelled &&
        unique_bytes_launched != report.scheduled_total_bytes) {
        fail("unique launched bytes " +
             std::to_string(unique_bytes_launched) +
             " differ from scheduled bytes " +
             std::to_string(report.scheduled_total_bytes));
    }

    // 不变量 3：峰值内存受限——在途桶数从不超过窗口；
    // 每个非超限桶不大于容量，因此峰值受窗口与容量的乘积约束。
    if (report.max_inflight_observed > config_.scheduler.max_inflight_buckets) {
        fail("inflight window exceeded: observed " +
             std::to_string(report.max_inflight_observed));
    }
    const std::size_t max_bucket_bytes =
        report.scheduled_max_bucket_bytes;
    // complete() 先分配补位桶、再回收完成桶，存在一个过渡时刻同时持有
    // max_inflight + 1 个桶，因此解析峰值界为 (窗口 + 1) × 最大桶。
    const std::size_t bound =
        (config_.scheduler.max_inflight_buckets + 1) * max_bucket_bytes;
    if (report.allocator_peak_bytes > bound) {
        fail("peak memory " +
             std::to_string(report.allocator_peak_bytes) +
             " exceeds analytic bound " + std::to_string(bound));
    }

    if (!report.cancelled) {
        std::size_t finished = 0;
        for (const LaunchRecord& launch : report.launches) {
            if (!launch.aborted) {
                ++finished;
            }
        }
        if (finished != report.launches.size()) {
            fail("unexpected aborted launch in uncancelled run");
        }
    }
}

}  // namespace dlks::formal
