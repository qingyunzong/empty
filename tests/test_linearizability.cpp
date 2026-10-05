#include "bq/bounded_queue.hpp"

#include <atomic>
#include <barrier>
#include <cstdint>
#include <thread>
#include <vector>

#include "check.hpp"
#include "tracked.hpp"

namespace {

// Each operation records a [begin, end) interval of globally unique ticks.
// Ticks come from one atomic counter, so a.end < b.begin implies a finished
// before b started in real time.
struct event {
    enum class kind { push, pop } k;
    int value;
    std::uint64_t begin;
    std::uint64_t end;
};

std::atomic<std::uint64_t> tick{0};
std::uint64_t next_tick() { return tick.fetch_add(1, std::memory_order_acq_rel); }

}  // namespace

int main() {
    // Phase 1: SPSC exact FIFO check — with one producer and one consumer
    // the dequeue sequence must equal the enqueue sequence exactly.
    {
        constexpr int kN = 20000;
        bq::bounded_queue<tracked> q(128);
        std::barrier start(3);
        std::atomic<bool> order_ok{true};

        std::thread producer([&] {
            start.arrive_and_wait();
            for (int i = 0; i < kN; ++i)
                CHECK(q.emplace(i));
            q.close();
        });
        std::thread consumer([&] {
            start.arrive_and_wait();
            int expected = 0;
            while (auto v = q.pop()) {
                if (v->value != expected++)
                    order_ok = false;
            }
            CHECK(expected == kN);
        });
        start.arrive_and_wait();
        producer.join();
        consumer.join();
        CHECK(order_ok.load());
    }

    // Phase 2: MPMC stress with per-operation history; afterwards verify
    // that a linearization exists.
    constexpr int kProducers = 4;
    constexpr int kConsumers = 4;
    constexpr int kPerProducer = 500;
    constexpr int kTotal = kProducers * kPerProducer;

    std::vector<std::vector<event>> producer_log(kProducers);
    std::vector<std::vector<event>> consumer_log(kConsumers);
    for (auto& v : producer_log)
        v.reserve(kPerProducer);
    for (auto& v : consumer_log)
        v.reserve(kTotal);

    {
        bq::bounded_queue<tracked> q(64);
        std::barrier start(kProducers + kConsumers + 1);
        std::atomic<long> tickets{0};
        std::vector<std::thread> threads;

        for (int p = 0; p < kProducers; ++p)
            threads.emplace_back([&, p] {
                start.arrive_and_wait();
                for (int i = 0; i < kPerProducer; ++i) {
                    int value = p * kPerProducer + i;
                    std::uint64_t t0 = next_tick();
                    bool ok = q.emplace(value);
                    std::uint64_t t1 = next_tick();
                    CHECK(ok);
                    producer_log[p].push_back({event::kind::push, value, t0, t1});
                }
            });
        for (int c = 0; c < kConsumers; ++c)
            threads.emplace_back([&, c] {
                start.arrive_and_wait();
                for (;;) {
                    long ticket = tickets.fetch_add(1, std::memory_order_relaxed);
                    if (ticket >= kTotal)
                        break;
                    std::uint64_t t0 = next_tick();
                    auto v = q.pop();
                    std::uint64_t t1 = next_tick();
                    CHECK(v.has_value());
                    consumer_log[c].push_back({event::kind::pop, v->value, t0, t1});
                }
            });

        start.arrive_and_wait();
        for (auto& t : threads)
            t.join();
        CHECK(q.try_pop() == std::nullopt);
    }

    // ---- linearizability analysis ----
    std::vector<event> ops;
    ops.reserve(2 * kTotal);
    for (auto& log : producer_log)
        ops.insert(ops.end(), log.begin(), log.end());
    for (auto& log : consumer_log)
        ops.insert(ops.end(), log.begin(), log.end());
    const int n = static_cast<int>(ops.size());
    CHECK(n == 2 * kTotal);

    // Every value is pushed exactly once and popped exactly once.
    std::vector<int> push_of(kTotal, -1), pop_of(kTotal, -1);
    for (int i = 0; i < n; ++i) {
        const event& e = ops[i];
        CHECK(e.value >= 0 && e.value < kTotal);
        if (e.k == event::kind::push) {
            CHECK(push_of[e.value] == -1);
            push_of[e.value] = i;
        } else {
            CHECK(pop_of[e.value] == -1);
            pop_of[e.value] = i;
        }
    }
    for (int v = 0; v < kTotal; ++v) {
        CHECK(push_of[v] != -1);
        CHECK(pop_of[v] != -1);
        // A pop cannot have finished before its push began.
        CHECK(ops[pop_of[v]].end > ops[push_of[v]].begin);
    }

    // Precedence graph over operations. Acyclicity means a linearization
    // consistent with all constraints exists.
    std::vector<std::vector<int>> adj(n);
    std::vector<int> indeg(n, 0);
    auto add_edge = [&](int a, int b) {
        adj[a].push_back(b);
        ++indeg[b];
    };

    // A value must be enqueued before it is dequeued.
    for (int v = 0; v < kTotal; ++v)
        add_edge(push_of[v], pop_of[v]);

    // Real-time order: a finished before b started => a precedes b.
    for (int a = 0; a < n; ++a)
        for (int b = 0; b < n; ++b)
            if (a != b && ops[a].end < ops[b].begin)
                add_edge(a, b);

    // FIFO: pushes from one producer are program-ordered, so their pops
    // must appear in the same order.
    for (int p = 0; p < kProducers; ++p)
        for (int i = 0; i + 1 < kPerProducer; ++i)
            add_edge(pop_of[p * kPerProducer + i], pop_of[p * kPerProducer + i + 1]);

    // Kahn's algorithm: all nodes processed <=> acyclic.
    std::vector<int> topo;
    topo.reserve(n);
    for (int i = 0; i < n; ++i)
        if (indeg[i] == 0)
            topo.push_back(i);
    std::size_t processed = 0;
    for (std::size_t head = 0; head < topo.size(); ++head) {
        ++processed;
        for (int w : adj[topo[head]])
            if (--indeg[w] == 0)
                topo.push_back(w);
    }
    CHECK(processed == static_cast<std::size_t>(n));

    // Lifetime: no leaks, no double destruction across the whole run.
    CHECK(tracked::stats().constructed == tracked::stats().destructed);
    CHECK(tracked::stats().double_destroys == 0);
    {
        std::lock_guard lock(tracked::live_mutex());
        CHECK(tracked::live_ids().empty());
    }

    PASS("test_linearizability");
}
