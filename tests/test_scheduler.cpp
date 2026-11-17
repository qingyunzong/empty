#include "dlks/formal/gradient_bucket_scheduler.hpp"

#include <cassert>
#include <cstdlib>
#include <cstddef>
#include <cstdint>
#include <iostream>
#include <memory>
#include <stdexcept>
#include <unordered_set>
#include <vector>

using dlks::formal::Buffer;
using dlks::formal::BucketInfo;
using dlks::formal::GradientBucketScheduler;
using dlks::formal::IBufferAllocator;
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

struct Harness {
    struct Event {
        std::uint64_t request_id;
        std::size_t bytes;
        std::vector<std::uint64_t> params;
    };

    std::vector<Event> launches;
    std::vector<std::uint64_t> aborts;
    std::unordered_set<std::uint64_t> held;

    auto makeLauncher() {
        return [this](std::uint64_t request_id, Buffer buffer,
                      const BucketInfo& bucket) {
            CHECK(buffer.valid());
            held.insert(request_id);
            launches.push_back(
                Event{request_id, bucket.bytes, bucket.param_ids});
        };
    }

    auto makeAbort() {
        return [this](std::uint64_t request_id, const BucketInfo&) {
            aborts.push_back(request_id);
            held.erase(request_id);
        };
    }

    void completeAll(GradientBucketScheduler& scheduler) {
        std::vector<std::uint64_t> ids;
        for (const Event& event : launches) {
            ids.push_back(event.request_id);
        }
        for (std::uint64_t id : ids) {
            if (held.erase(id) != 0U) {
                scheduler.complete(id);
            }
        }
    }
};

void test_capacity_packing() {
    Harness harness;
    auto allocator = std::make_shared<TrackingMallocAllocator>();
    GradientBucketScheduler scheduler(
        SchedulerConfig{.bucket_capacity_bytes = 1000,
                        .max_inflight_buckets = 4},
        harness.makeLauncher(), allocator, harness.makeAbort());

    scheduler.register_tensor(1, 400);
    scheduler.register_tensor(2, 400);
    scheduler.register_tensor(3, 400);  // 装不下 -> 第二个桶
    scheduler.flush();

    CHECK(scheduler.bucket_count() == 2);
    CHECK(scheduler.total_scheduled_bytes() == 1200);
    CHECK(harness.launches.empty());  // 未就绪不得发射

    scheduler.mark_ready(1);
    scheduler.mark_ready(2);
    CHECK(harness.launches.size() == 1);
    CHECK(harness.launches[0].bytes == 800);

    scheduler.mark_ready(3);
    CHECK(harness.launches.size() == 2);
    CHECK(scheduler.inflight_count() == 2);

    harness.completeAll(scheduler);
    CHECK(scheduler.completed_count() == 2);
    CHECK(allocator->live_bytes() == 0);
    CHECK(allocator->allocation_count() == allocator->deallocation_count());
}

void test_shared_param_dedup() {
    Harness harness;
    auto allocator = std::make_shared<TrackingMallocAllocator>();
    GradientBucketScheduler scheduler(
        SchedulerConfig{.bucket_capacity_bytes = 1000,
                        .max_inflight_buckets = 4},
        harness.makeLauncher(), allocator, harness.makeAbort());

    // 参数 7 被两个反向节点共享：登记两次，字节只归集一次，
    // 但必须两次 mark_ready 后所属桶才允许发射。
    scheduler.register_tensor(7, 300);
    scheduler.register_tensor(8, 200);
    scheduler.register_tensor(7, 300);
    scheduler.flush();

    CHECK(scheduler.bucket_count() == 1);
    CHECK(scheduler.total_scheduled_bytes() == 500);

    scheduler.mark_ready(7);
    scheduler.mark_ready(8);
    CHECK(harness.launches.empty());  // 参数 7 还差一次贡献
    scheduler.mark_ready(7);
    CHECK(harness.launches.size() == 1);
    CHECK(harness.launches[0].bytes == 500);
    CHECK(harness.launches[0].params.size() == 2);

    harness.completeAll(scheduler);
    CHECK(allocator->live_bytes() == 0);
}

void test_inflight_window() {
    Harness harness;
    auto allocator = std::make_shared<TrackingMallocAllocator>();
    GradientBucketScheduler scheduler(
        SchedulerConfig{.bucket_capacity_bytes = 100,
                        .max_inflight_buckets = 2},
        harness.makeLauncher(), allocator, harness.makeAbort());

    for (std::uint64_t p = 1; p <= 6; ++p) {
        scheduler.register_tensor(p, 100);  // 每参数独占一个桶
    }
    scheduler.flush();
    for (std::uint64_t p = 1; p <= 6; ++p) {
        scheduler.mark_ready(p);
    }

    CHECK(harness.launches.size() == 2);
    CHECK(scheduler.inflight_count() == 2);
    CHECK(allocator->live_bytes() == 200);

    scheduler.complete(harness.launches[0].request_id);
    CHECK(harness.launches.size() == 3);
    CHECK(scheduler.inflight_count() == 2);

    while (scheduler.completed_count() < 6) {
        const std::uint64_t id =
            harness.launches[scheduler.completed_count()].request_id;
        harness.held.erase(id);
        scheduler.complete(id);
    }
    CHECK(harness.launches.size() == 6);
    CHECK(allocator->live_bytes() == 0);
    CHECK(allocator->peak_bytes() <= 300);
    CHECK(allocator->peak_bytes() >= 100);
}

void test_oversized_param() {
    Harness harness;
    GradientBucketScheduler scheduler(
        SchedulerConfig{.bucket_capacity_bytes = 100,
                        .max_inflight_buckets = 2},
        harness.makeLauncher(),
        std::make_shared<TrackingMallocAllocator>(), harness.makeAbort());

    scheduler.register_tensor(1, 50);
    scheduler.register_tensor(2, 250);  // 超限：独占桶并立即封闭
    scheduler.register_tensor(3, 50);
    scheduler.flush();

    CHECK(scheduler.bucket_count() == 3);
    for (std::uint64_t p = 1; p <= 3; ++p) {
        scheduler.mark_ready(p);
    }
    // 窗口为 2：先发射两个桶，完成一个后第三个桶补位。
    CHECK(harness.launches.size() == 2);
    CHECK(harness.launches[1].bytes == 250);
    harness.held.erase(harness.launches[0].request_id);
    scheduler.complete(harness.launches[0].request_id);
    CHECK(harness.launches.size() == 3);
    harness.completeAll(scheduler);
    CHECK(scheduler.completed_count() == 3);
}

void test_cancel_safety() {
    Harness harness;
    auto allocator = std::make_shared<TrackingMallocAllocator>();
    auto scheduler = std::make_unique<GradientBucketScheduler>(
        SchedulerConfig{.bucket_capacity_bytes = 100,
                        .max_inflight_buckets = 4},
        harness.makeLauncher(), allocator, harness.makeAbort());

    for (std::uint64_t p = 1; p <= 4; ++p) {
        scheduler->register_tensor(p, 100);
    }
    scheduler->flush();
    for (std::uint64_t p = 1; p <= 4; ++p) {
        scheduler->mark_ready(p);
    }
    CHECK(harness.launches.size() == 4);
    CHECK(allocator->live_bytes() == 400);

    scheduler->cancel();
    CHECK(scheduler->is_cancelled());
    CHECK(harness.aborts.size() == 4);
    CHECK(allocator->live_bytes() == 0);
    CHECK(scheduler->inflight_count() == 0);

    // 取消后迟到的完成事件是安全空操作，不释放、不崩溃。
    for (const Harness::Event& event : harness.launches) {
        CHECK(!scheduler->complete(event.request_id));
    }
    // 重复取消幂等。
    scheduler->cancel();
    CHECK(harness.aborts.size() == 4);

    bool threw = false;
    try {
        scheduler->register_tensor(9, 10);
    } catch (const std::logic_error&) {
        threw = true;
    }
    CHECK(threw);
    scheduler->mark_ready(1);  // 取消后静默忽略

    scheduler.reset();  // 析构时无在途缓冲，无泄漏无 double-free
    CHECK(allocator->live_bytes() == 0);
    CHECK(allocator->allocation_count() == allocator->deallocation_count());
}

void test_input_validation() {
    Harness harness;
    GradientBucketScheduler scheduler(
        SchedulerConfig{.bucket_capacity_bytes = 100,
                        .max_inflight_buckets = 1},
        harness.makeLauncher(),
        std::make_shared<TrackingMallocAllocator>(), harness.makeAbort());

    bool threw = false;
    try {
        scheduler.register_tensor(1, 0);
    } catch (const std::invalid_argument&) {
        threw = true;
    }
    CHECK(threw);

    threw = false;
    try {
        scheduler.mark_ready(42);
    } catch (const std::invalid_argument&) {
        threw = true;
    }
    CHECK(threw);

    scheduler.register_tensor(1, 10);
    scheduler.flush();
    scheduler.mark_ready(1);
    threw = false;
    try {
        scheduler.mark_ready(1);  // 多于登记次数
    } catch (const std::logic_error&) {
        threw = true;
    }
    CHECK(threw);
}

void test_constructor_validation() {
    bool threw = false;
    try {
        GradientBucketScheduler bad(
            SchedulerConfig{.bucket_capacity_bytes = 0,
                            .max_inflight_buckets = 1},
            [](std::uint64_t, Buffer, const BucketInfo&) {});
        (void)bad;
    } catch (const std::invalid_argument&) {
        threw = true;
    }
    CHECK(threw);

    threw = false;
    try {
        GradientBucketScheduler bad(
            SchedulerConfig{.bucket_capacity_bytes = 10,
                            .max_inflight_buckets = 0},
            nullptr);
        (void)bad;
    } catch (const std::invalid_argument&) {
        threw = true;
    }
    CHECK(threw);
}

}  // namespace

int main() {
    test_capacity_packing();
    test_shared_param_dedup();
    test_inflight_window();
    test_oversized_param();
    test_cancel_safety();
    test_input_validation();
    test_constructor_validation();
    std::cout << "scheduler tests: all 7 cases passed\n";
    return 0;
}
