#include "dlks_formal.hpp"

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <iostream>
#include <limits>
#include <string>
#include <utility>
#include <vector>

namespace {

using dlks::HierarchicalScheduler;
using dlks::Packet;
using dlks::PacketBytes;
using dlks::SchedulerTime;
using dlks::TokenBucketConfig;

int failures = 0;

void check(bool condition, const char* expression, const char* file, int line) {
    if (!condition) {
        std::cerr << file << ':' << line << ": CHECK failed: " << expression << '\n';
        ++failures;
    }
}

void check_near(double actual, double expected, double tolerance, const char* what,
                const char* file, int line) {
    if (!(std::fabs(actual - expected) <= tolerance)) {
        std::cerr << file << ':' << line << ": CHECK_NEAR failed: " << what << " actual="
                  << actual << " expected=" << expected << " tolerance=" << tolerance
                  << '\n';
        ++failures;
    }
}

#define CHECK(expression) check((expression), #expression, __FILE__, __LINE__)
#define CHECK_NEAR(actual, expected, tolerance, what) \
    check_near((actual), (expected), (tolerance), (what), __FILE__, __LINE__)

constexpr std::uint64_t kScaleNs = 1'000'000'000ULL;
constexpr SchedulerTime kNever = std::numeric_limits<SchedulerTime>::max();

std::uint64_t serialization_ns(PacketBytes bytes, std::uint64_t link_bytes_per_sec) {
    const std::uint64_t numerator = static_cast<std::uint64_t>(bytes) * kScaleNs;
    const std::uint64_t duration =
        numerator / link_bytes_per_sec + (numerator % link_bytes_per_sec != 0 ? 1 : 0);
    return std::max<std::uint64_t>(duration, 1);
}

struct Delivery {
    SchedulerTime start{};
    SchedulerTime finish{};
    HierarchicalScheduler::SelectedPacket selected{};
};

// Small discrete-event driver.  Time advances only to the next packet
// completion, arrival/configuration action, or token-bucket readiness event.
class EventSim {
public:
    EventSim(HierarchicalScheduler& scheduler, std::uint64_t link_bytes_per_sec)
        : scheduler_(scheduler), link_bytes_per_sec_(link_bytes_per_sec) {}

    void schedule(SchedulerTime time, std::function<void()> action) {
        actions_.push_back(Action{time, next_order_++, std::move(action)});
        std::stable_sort(actions_.begin(), actions_.end(),
                         [](const Action& lhs, const Action& rhs) {
                             if (lhs.time != rhs.time) {
                                 return lhs.time < rhs.time;
                             }
                             return lhs.order < rhs.order;
                         });
    }

    bool run_until_total(std::size_t target_packets,
                         std::size_t max_iterations = 20'000'000) {
        std::size_t iterations = 0;
        while (deliveries_.size() < target_packets) {
            if (++iterations > max_iterations) {
                return false;
            }

            const SchedulerTime next_action = next_action_time();
            if (busy_) {
                if (next_action < free_at_) {
                    now_ = std::max(now_, next_action);
                    apply_actions(now_);
                    continue;
                }
                now_ = std::max(now_, free_at_);
                busy_ = false;
                apply_actions(now_);
                continue;
            }

            if (next_action <= now_) {
                apply_actions(now_);
                continue;
            }

            auto selected = scheduler_.dequeue_selected(now_);
            if (selected) {
                const SchedulerTime finish =
                    now_ + static_cast<SchedulerTime>(
                               serialization_ns(selected->packet.bytes, link_bytes_per_sec_));
                deliveries_.push_back(Delivery{now_, finish, *selected});
                free_at_ = finish;
                busy_ = true;
                continue;
            }

            SchedulerTime candidate = kNever;
            const auto ready = scheduler_.next_ready_time(now_);
            if (ready && *ready > now_) {
                candidate = std::min(candidate, *ready);
            }
            if (next_action != kNever && next_action > now_) {
                candidate = std::min(candidate, next_action);
            }
            if (candidate == kNever || candidate <= now_) {
                break;
            }
            now_ = candidate;
        }
        return deliveries_.size() >= target_packets;
    }

    SchedulerTime now() const { return now_; }
    const std::vector<Delivery>& deliveries() const { return deliveries_; }

private:
    struct Action {
        SchedulerTime time{};
        std::uint64_t order{};
        std::function<void()> callback;
    };

    SchedulerTime next_action_time() const {
        if (action_index_ >= actions_.size()) {
            return kNever;
        }
        return actions_[action_index_].time;
    }

    void apply_actions(SchedulerTime up_to) {
        while (action_index_ < actions_.size() && actions_[action_index_].time <= up_to) {
            now_ = std::max(now_, actions_[action_index_].time);
            auto callback = std::move(actions_[action_index_].callback);
            ++action_index_;
            callback();
        }
    }

    HierarchicalScheduler& scheduler_;
    std::uint64_t link_bytes_per_sec_;
    SchedulerTime now_{};
    bool busy_{};
    SchedulerTime free_at_{};
    std::uint64_t next_order_{};
    std::size_t action_index_{};
    std::vector<Action> actions_;
    std::vector<Delivery> deliveries_;
};

struct Totals {
    std::uint64_t packets{};
    std::uint64_t bytes{};
};

Totals totals_for(const std::vector<Delivery>& deliveries,
                  HierarchicalScheduler::NodeId queue, std::size_t begin = 0,
                  std::size_t end = std::numeric_limits<std::size_t>::max()) {
    end = std::min(end, deliveries.size());
    Totals totals;
    for (std::size_t i = begin; i < end; ++i) {
        if (deliveries[i].selected.queue == queue) {
            ++totals.packets;
            totals.bytes += deliveries[i].selected.packet.bytes;
        }
    }
    return totals;
}

std::uint64_t max_window_bytes(const std::vector<Delivery>& deliveries,
                               SchedulerTime window_ns) {
    std::uint64_t current = 0;
    std::uint64_t maximum = 0;
    std::size_t left = 0;
    for (std::size_t right = 0; right < deliveries.size(); ++right) {
        current += deliveries[right].selected.packet.bytes;
        while (left <= right &&
               deliveries[right].start - deliveries[left].start > window_ns) {
            current -= deliveries[left].selected.packet.bytes;
            ++left;
        }
        maximum = std::max(maximum, current);
    }
    return maximum;
}

void enqueue_batch(HierarchicalScheduler& scheduler,
                   HierarchicalScheduler::NodeId queue, std::size_t count,
                   PacketBytes bytes, SchedulerTime now) {
    for (std::size_t i = 0; i < count; ++i) {
        const bool ok = scheduler.enqueue(
            queue, Packet{static_cast<std::uint64_t>(i), bytes}, now);
        CHECK(ok);
    }
}

void test_weighted_bandwidth() {
    HierarchicalScheduler scheduler;
    const auto queue_a = scheduler.add_queue(HierarchicalScheduler::kRoot, 2);
    const auto queue_b = scheduler.add_queue(HierarchicalScheduler::kRoot, 1);
    CHECK(queue_a != HierarchicalScheduler::kInvalid);
    CHECK(queue_b != HierarchicalScheduler::kInvalid);

    enqueue_batch(scheduler, queue_a, 10'000, 1'000, 0);
    enqueue_batch(scheduler, queue_b, 10'000, 1'000, 0);

    EventSim sim(scheduler, 100'000'000);
    CHECK(sim.run_until_total(6'000));
    const auto a = totals_for(sim.deliveries(), queue_a);
    const auto b = totals_for(sim.deliveries(), queue_b);
    const double share_a =
        static_cast<double>(a.bytes) / static_cast<double>(a.bytes + b.bytes);
    CHECK_NEAR(share_a, 2.0 / 3.0, 0.01, "two-to-one byte share");
    CHECK(a.bytes > b.bytes);
}

void test_packet_length_fairness() {
    HierarchicalScheduler scheduler;
    const auto queue_a = scheduler.add_queue(HierarchicalScheduler::kRoot, 1);
    const auto queue_b = scheduler.add_queue(HierarchicalScheduler::kRoot, 1);

    enqueue_batch(scheduler, queue_a, 12'000, 400, 0);
    enqueue_batch(scheduler, queue_b, 4'000, 1'200, 0);

    EventSim sim(scheduler, 100'000'000);
    CHECK(sim.run_until_total(8'000));
    const auto a = totals_for(sim.deliveries(), queue_a);
    const auto b = totals_for(sim.deliveries(), queue_b);
    const double byte_share =
        static_cast<double>(a.bytes) / static_cast<double>(a.bytes + b.bytes);
    const double packet_ratio =
        static_cast<double>(a.packets) / static_cast<double>(b.packets);
    CHECK_NEAR(byte_share, 0.5, 0.02, "equal-weight byte fairness");
    CHECK_NEAR(packet_ratio, 3.0, 0.15, "packet count reflects 3x packet length");
}

void test_hierarchical_weights() {
    HierarchicalScheduler scheduler;
    const auto group_1 = scheduler.add_group(HierarchicalScheduler::kRoot, 3);
    const auto group_2 = scheduler.add_group(HierarchicalScheduler::kRoot, 1);
    const auto queue_a = scheduler.add_queue(group_1, 1);
    const auto queue_b = scheduler.add_queue(group_1, 1);
    const auto queue_c = scheduler.add_queue(group_2, 1);

    enqueue_batch(scheduler, queue_a, 8'000, 1'000, 0);
    enqueue_batch(scheduler, queue_b, 8'000, 1'000, 0);
    enqueue_batch(scheduler, queue_c, 8'000, 1'000, 0);

    EventSim sim(scheduler, 100'000'000);
    CHECK(sim.run_until_total(6'000));
    const auto a = totals_for(sim.deliveries(), queue_a);
    const auto b = totals_for(sim.deliveries(), queue_b);
    const auto c = totals_for(sim.deliveries(), queue_c);
    const double group_share = static_cast<double>(a.bytes + b.bytes) /
                               static_cast<double>(a.bytes + b.bytes + c.bytes);
    const double inner_share =
        static_cast<double>(a.bytes) / static_cast<double>(a.bytes + b.bytes);
    CHECK_NEAR(group_share, 0.75, 0.01, "3:1 class aggregate");
    CHECK_NEAR(inner_share, 0.5, 0.02, "equal queues inside class");
    CHECK(c.bytes > 0);
}

void test_token_bucket_peak() {
    HierarchicalScheduler scheduler;
    const auto queue = scheduler.add_queue(
        HierarchicalScheduler::kRoot, 1,
        TokenBucketConfig{1'000'000, 10'000});
    CHECK(queue != HierarchicalScheduler::kInvalid);
    enqueue_batch(scheduler, queue, 5'000, 1'000, 0);

    EventSim sim(scheduler, 100'000'000);
    CHECK(sim.run_until_total(2'200));
    const auto& deliveries = sim.deliveries();

    const std::uint64_t short_burst =
        max_window_bytes(deliveries, 1'000'000);  // 1 ms
    CHECK(short_burst <= 10'000 + 1'000);

    const std::uint64_t twenty_ms = max_window_bytes(deliveries, 20'000'000);
    // burst + rate * 20 ms + one packet of integer-rounding slack
    CHECK(twenty_ms <= 10'000 + 20'000 + 1'000);

    std::uint64_t bytes_in_two_seconds = 0;
    for (const auto& delivery : deliveries) {
        if (delivery.start <= 2'000'000'000LL) {
            bytes_in_two_seconds += delivery.selected.packet.bytes;
        }
    }
    CHECK(bytes_in_two_seconds <= 10'000 + 2'000'000 + 1'000);
    CHECK(bytes_in_two_seconds >= 1'950'000);
}

void test_idle_queue_recovery() {
    HierarchicalScheduler scheduler;
    const auto queue_a = scheduler.add_queue(HierarchicalScheduler::kRoot, 1);
    const auto queue_b = scheduler.add_queue(HierarchicalScheduler::kRoot, 1);
    enqueue_batch(scheduler, queue_a, 20'000, 1'000, 0);

    EventSim sim(scheduler, 100'000'000);
    CHECK(sim.run_until_total(400));

    const SchedulerTime recovery = sim.now();
    enqueue_batch(scheduler, queue_b, 20'000, 1'000, recovery);
    CHECK(sim.run_until_total(800));

    const auto& deliveries = sim.deliveries();
    const auto b_recovered = totals_for(deliveries, queue_b, 400, 800);
    const auto b_first_40 = totals_for(deliveries, queue_b, 400, 440);
    CHECK(b_recovered.packets >= 170 && b_recovered.packets <= 230);
    CHECK(b_first_40.packets >= 12 && b_first_40.packets <= 28);
}

void test_stale_finish_recovery() {
    HierarchicalScheduler scheduler;
    const auto queue_a = scheduler.add_queue(HierarchicalScheduler::kRoot, 1);
    const auto queue_b = scheduler.add_queue(HierarchicalScheduler::kRoot, 1);

    // Give B a real finish-tag history, then let it go idle while A advances
    // the parent virtual clock.
    enqueue_batch(scheduler, queue_b, 100, 1'000, 0);
    EventSim sim(scheduler, 100'000'000);
    CHECK(sim.run_until_total(100));
    CHECK(scheduler.backlog_packets(queue_b) == 0);

    enqueue_batch(scheduler, queue_a, 20'000, 1'000, sim.now());
    CHECK(sim.run_until_total(600));

    const SchedulerTime recovery = sim.now();
    enqueue_batch(scheduler, queue_b, 20'000, 1'000, recovery);
    CHECK(sim.run_until_total(1'000));

    const auto b_after = totals_for(sim.deliveries(), queue_b, 600, 1'000);
    const auto b_first_40 = totals_for(sim.deliveries(), queue_b, 600, 640);
    CHECK(b_after.packets >= 170 && b_after.packets <= 230);
    CHECK(b_first_40.packets >= 12 && b_first_40.packets <= 28);
}

void test_empty_group_recovery() {
    HierarchicalScheduler scheduler;
    const auto group_a = scheduler.add_group(HierarchicalScheduler::kRoot, 1);
    const auto group_b = scheduler.add_group(HierarchicalScheduler::kRoot, 1);
    const auto queue_a = scheduler.add_queue(group_a, 1);
    const auto queue_b = scheduler.add_queue(group_b, 1);

    enqueue_batch(scheduler, queue_a, 300, 1'000, 0);
    EventSim sim(scheduler, 100'000'000);
    CHECK(sim.run_until_total(300));
    CHECK(scheduler.backlog_packets(group_a) == 0);

    enqueue_batch(scheduler, queue_b, 10'000, 1'000, sim.now());
    CHECK(sim.run_until_total(600));

    const SchedulerTime recovery = sim.now();
    enqueue_batch(scheduler, queue_a, 10'000, 1'000, recovery);
    CHECK(sim.run_until_total(1'000));

    const auto& deliveries = sim.deliveries();
    const auto a_after = totals_for(deliveries, queue_a, 600, 1'000);
    const auto a_first_40 = totals_for(deliveries, queue_a, 600, 640);
    CHECK(a_after.packets >= 170 && a_after.packets <= 230);
    CHECK(a_first_40.packets >= 12 && a_first_40.packets <= 28);
}

void test_smooth_weight_updates() {
    HierarchicalScheduler scheduler;
    const auto queue_a = scheduler.add_queue(HierarchicalScheduler::kRoot, 1);
    const auto queue_b = scheduler.add_queue(HierarchicalScheduler::kRoot, 1);
    enqueue_batch(scheduler, queue_a, 30'000, 1'000, 0);
    enqueue_batch(scheduler, queue_b, 30'000, 1'000, 0);

    EventSim sim(scheduler, 100'000'000);
    CHECK(sim.run_until_total(1'000));

    CHECK(scheduler.set_weight(queue_a, 8));
    CHECK(sim.run_until_total(4'000));
    const auto& after_increase = sim.deliveries();
    const auto a_high = totals_for(after_increase, queue_a, 1'000, 4'000);
    const auto b_high = totals_for(after_increase, queue_b, 1'000, 4'000);
    const double high_share =
        static_cast<double>(a_high.bytes) /
        static_cast<double>(a_high.bytes + b_high.bytes);
    CHECK_NEAR(high_share, 8.0 / 9.0, 0.015, "weight increase bandwidth");

    std::size_t first_b_after_change = 4'000;
    for (std::size_t i = 1'000; i < 4'000; ++i) {
        if (after_increase[i].selected.queue == queue_b) {
            first_b_after_change = i - 1'000;
            break;
        }
    }
    CHECK(first_b_after_change < 12);

    for (std::size_t begin = 1'000; begin < 4'000; begin += 100) {
        const auto window_b = totals_for(after_increase, queue_b, begin, begin + 100);
        CHECK(window_b.packets >= 5);
    }

    CHECK(scheduler.set_weight(queue_a, 1));
    CHECK(sim.run_until_total(5'000));
    const auto& after_decrease = sim.deliveries();
    const auto a_low = totals_for(after_decrease, queue_a, 4'000, 5'000);
    const auto b_low = totals_for(after_decrease, queue_b, 4'000, 5'000);
    const double low_share =
        static_cast<double>(a_low.bytes) /
        static_cast<double>(a_low.bytes + b_low.bytes);
    CHECK_NEAR(low_share, 0.5, 0.03, "weight decrease bandwidth");
    const auto a_first_100 = totals_for(after_decrease, queue_a, 4'000, 4'100);
    CHECK(a_first_100.packets <= 70);
}

void test_stable_tie_order() {
    HierarchicalScheduler scheduler;
    const auto queue_a = scheduler.add_queue(HierarchicalScheduler::kRoot, 1);
    const auto queue_b = scheduler.add_queue(HierarchicalScheduler::kRoot, 1);
    const auto queue_c = scheduler.add_queue(HierarchicalScheduler::kRoot, 1);

    for (std::size_t round = 0; round < 10; ++round) {
        CHECK(scheduler.enqueue(queue_a, Packet{round * 3, 600}, 0));
        CHECK(scheduler.enqueue(queue_b, Packet{round * 3 + 1, 600}, 0));
        CHECK(scheduler.enqueue(queue_c, Packet{round * 3 + 2, 600}, 0));
    }

    EventSim sim(scheduler, 100'000'000);
    CHECK(sim.run_until_total(30));
    for (std::size_t i = 0; i < 30; ++i) {
        CHECK(sim.deliveries()[i].selected.packet.id == i);
    }

    HierarchicalScheduler cross_tag;
    const auto short_queue = cross_tag.add_queue(HierarchicalScheduler::kRoot, 1);
    const auto wide_queue = cross_tag.add_queue(HierarchicalScheduler::kRoot, 2);
    CHECK(cross_tag.enqueue(short_queue, Packet{0, 100}, 0));
    CHECK(cross_tag.enqueue(wide_queue, Packet{1, 200}, 0));
    CHECK(cross_tag.enqueue(short_queue, Packet{2, 100}, 0));
    CHECK(cross_tag.enqueue(wide_queue, Packet{3, 200}, 0));

    EventSim cross_sim(cross_tag, 100'000'000);
    CHECK(cross_sim.run_until_total(4));
    CHECK(cross_sim.deliveries()[0].selected.packet.id == 0);
    CHECK(cross_sim.deliveries()[1].selected.packet.id == 1);
    CHECK(cross_sim.deliveries()[2].selected.packet.id == 2);
    CHECK(cross_sim.deliveries()[3].selected.packet.id == 3);
}

void test_group_shaper() {
    HierarchicalScheduler scheduler;
    const auto limited = scheduler.add_group(
        HierarchicalScheduler::kRoot, 1, TokenBucketConfig{500'000, 5'000});
    const auto unlimited = scheduler.add_group(HierarchicalScheduler::kRoot, 1);
    const auto queue_a = scheduler.add_queue(limited, 1);
    const auto queue_b = scheduler.add_queue(limited, 1);
    const auto queue_c = scheduler.add_queue(unlimited, 1);
    CHECK(limited != HierarchicalScheduler::kInvalid);

    enqueue_batch(scheduler, queue_a, 4'000, 1'000, 0);
    enqueue_batch(scheduler, queue_b, 4'000, 1'000, 0);
    enqueue_batch(scheduler, queue_c, 8'000, 1'000, 0);

    EventSim sim(scheduler, 2'000'000);
    CHECK(sim.run_until_total(4'000));
    const auto a = totals_for(sim.deliveries(), queue_a);
    const auto b = totals_for(sim.deliveries(), queue_b);
    const auto c = totals_for(sim.deliveries(), queue_c);

    const std::uint64_t limited_bytes = a.bytes + b.bytes;
    CHECK(limited_bytes <= 500'000 * 2 + 5'000 + 2'000);
    CHECK(limited_bytes >= 950'000);
    CHECK(c.bytes >= 2'800'000);
    CHECK(a.bytes > 0 && b.bytes > 0);
}

void test_group_shaper_does_not_starve_large_packets() {
    HierarchicalScheduler scheduler;
    const auto group = scheduler.add_group(
        HierarchicalScheduler::kRoot, 1, TokenBucketConfig{10'000, 10'000});
    const auto large = scheduler.add_queue(group, 1);
    const auto small = scheduler.add_queue(group, 1);
    CHECK(group != HierarchicalScheduler::kInvalid);

    enqueue_batch(scheduler, large, 5'000, 1'500, 0);
    enqueue_batch(scheduler, small, 50'000, 100, 0);

    EventSim sim(scheduler, 10'000'000);
    CHECK(sim.run_until_total(300));
    const auto large_totals = totals_for(sim.deliveries(), large);
    const auto small_totals = totals_for(sim.deliveries(), small);
    const double large_share =
        static_cast<double>(large_totals.bytes) /
        static_cast<double>(large_totals.bytes + small_totals.bytes);
    CHECK(large_totals.packets >= 5);
    CHECK_NEAR(large_share, 0.5, 0.2, "large packets are not starved by small ones");
}

void test_shaper_ready_time() {
    HierarchicalScheduler scheduler;
    const auto queue = scheduler.add_queue(
        HierarchicalScheduler::kRoot, 1, TokenBucketConfig{1'000, 1'000});
    enqueue_batch(scheduler, queue, 3, 500, 0);
    CHECK(scheduler.next_ready_time(0).has_value());
    CHECK(*scheduler.next_ready_time(0) == 0);
    CHECK(scheduler.dequeue(0).has_value());
    CHECK(scheduler.dequeue(0).has_value());
    CHECK(!scheduler.dequeue(0).has_value());
    const auto ready = scheduler.next_ready_time(0);
    CHECK(ready.has_value());
    CHECK(*ready == 500'000'000);
    CHECK(scheduler.dequeue(*ready).has_value());

    HierarchicalScheduler impossible;
    const auto too_large = impossible.add_queue(
        HierarchicalScheduler::kRoot, 1, TokenBucketConfig{1'000, 400});
    CHECK(impossible.enqueue(too_large, Packet{1, 500}, 0));
    CHECK(!impossible.dequeue(0).has_value());
    CHECK(!impossible.next_ready_time(0).has_value());
}

void test_api_guards_and_peek() {
    HierarchicalScheduler scheduler;
    CHECK(scheduler.add_queue(HierarchicalScheduler::kRoot, 0) ==
          HierarchicalScheduler::kInvalid);
    CHECK(scheduler.add_queue(HierarchicalScheduler::kRoot, 1,
                              TokenBucketConfig{0, 1'000}) ==
          HierarchicalScheduler::kInvalid);
    CHECK(scheduler.add_queue(HierarchicalScheduler::kRoot, 1,
                              TokenBucketConfig{1'000, 0}) ==
          HierarchicalScheduler::kInvalid);

    const auto queue = scheduler.add_queue(HierarchicalScheduler::kRoot, 1);
    CHECK(!scheduler.set_weight(HierarchicalScheduler::kRoot, 1));
    CHECK(!scheduler.set_weight(queue, 0));
    CHECK(!scheduler.enqueue(queue, Packet{1, 0}, 0));
    CHECK(!scheduler.enqueue(HierarchicalScheduler::kInvalid, Packet{1, 1}, 0));
    CHECK(!scheduler.enqueue(HierarchicalScheduler::kRoot, Packet{1, 1}, 0));
    CHECK(scheduler.add_queue(queue, 1) == HierarchicalScheduler::kInvalid);
    CHECK(!scheduler.next_ready_time(0).has_value());
    CHECK(scheduler.empty());

    CHECK(scheduler.enqueue(queue, Packet{7, 500}, 0));
    CHECK(scheduler.backlog_packets() == 1);
    const auto peeked = scheduler.peek(0);
    CHECK(peeked.has_value());
    CHECK(peeked->packet.id == 7);
    CHECK(scheduler.backlog_packets() == 1);

    const auto selected = scheduler.dequeue_selected(0);
    CHECK(selected.has_value());
    CHECK(selected->packet.id == 7);
    CHECK(selected->queue == queue);
    CHECK(scheduler.empty());
}

}  // namespace

int main() {
    test_weighted_bandwidth();
    test_packet_length_fairness();
    test_hierarchical_weights();
    test_token_bucket_peak();
    test_idle_queue_recovery();
    test_stale_finish_recovery();
    test_empty_group_recovery();
    test_smooth_weight_updates();
    test_stable_tie_order();
    test_group_shaper();
    test_group_shaper_does_not_starve_large_packets();
    test_shaper_ready_time();
    test_api_guards_and_peek();

    if (failures != 0) {
        std::cerr << failures << " check(s) failed\n";
        return 1;
    }
    std::cout << "all scheduler checks passed\n";
    return 0;
}
