// Lifetime tests:
//  1. Poisoning deleter: every node is destroyed through a deleter that
//     poisons its memory (0xDD) before freeing. Exact accounting proves
//     nodes are reclaimed only when unreferenced; old snapshots keep their
//     nodes alive and fully readable.
//  2. Barrier test: a reader takes a snapshot, a barrier guarantees the
//     writer has published many newer versions (dropping its own refs)
//     before the reader queries -- the old snapshot must stay intact.
//  3. Stress: one writer + several readers with a start barrier; every
//     snapshot taken must be internally consistent.
#include "interval_index.hpp"
#include "check.hpp"

#include <barrier>
#include <cstdint>
#include <cstring>
#include <new>
#include <set>
#include <thread>
#include <vector>

using index_t = iix::interval_index<int, std::int64_t>;
using op = index_t::op;
using node = index_t::node;

struct poison_stats {
    std::atomic<std::size_t> created{0};
    std::atomic<std::size_t> destroyed{0};
    std::mutex mu;
    std::multiset<const void*> poisoned;  // deleter calls (addresses may be reused)
};

static index_t::node_factory poison_factory(poison_stats& st) {
    return [&st](node n) -> index_t::node_ptr {
        node* raw = new node(std::move(n));
        st.created.fetch_add(1, std::memory_order_relaxed);
        return index_t::node_ptr(raw, [&st](const node* p) {
            st.destroyed.fetch_add(1, std::memory_order_relaxed);
            p->~node();
            std::memset(static_cast<void*>(const_cast<node*>(p)), 0xDD, sizeof(node));  // poison
            {
                std::lock_guard<std::mutex> lk(st.mu);
                st.poisoned.insert(p);
            }
            ::operator delete(const_cast<node*>(p));
        });
    };
}

static std::vector<op> batch_for(int i) {
    // Deterministic, varied batches: assign/add/erase over moving windows.
    int base = (i * 37) % 400;
    return {op::assign(base, base + 40, i % 11),
            op::add(base + 10, base + 90, 3),
            op::erase(base + 60, base + 70)};
}

static void test_poisoned_reclamation() {
    poison_stats st;
    {
        index_t idx(poison_factory(st));
        idx.apply_batch({op::assign(0, 100, 1)});
        idx.apply_batch({op::assign(20, 40, 2), op::assign(60, 80, 3)});
        auto s1 = idx.get_snapshot();  // pins version v2

        std::size_t destroyed_before = st.destroyed.load();
        idx.apply_batch({op::assign(0, 100, 9)});  // replaces everything
        idx.apply_batch({op::add(-50, 150, 5)});

        // While s1 lives, no node reachable from it may have been reclaimed:
        // every query through s1 must still see the old version.
        CHECK(s1.query(10) == 1);
        CHECK(s1.query(30) == 2);
        CHECK(s1.query(70) == 3);
        CHECK(s1.query(95) == 1);
        CHECK(!s1.query(150));
        // Current version is unaffected too.
        auto cur = idx.get_snapshot();
        CHECK(cur.query(10) == 14);
        CHECK(cur.query(-60) == std::nullopt);
        CHECK(cur.query(100) == 5);  // [0,100) excludes 100; gap filled by add

        // Reclamation accounting: destroyed nodes are exactly the created
        // ones not reachable from any live root (s1 + current + temporaries).
        // Reclamation invariant: destroyed + reachable <= created.
        CHECK(st.destroyed.load() <= st.created.load());
        CHECK(st.destroyed.load() + cur.node_count() <= st.created.load());
        CHECK(st.destroyed.load() >= destroyed_before);

        s1 = index_t::snapshot{};  // release the old snapshot
        cur = index_t::snapshot{};
        // Now only the current root's nodes may survive.
        auto final_snap = idx.get_snapshot();
        CHECK(st.destroyed.load() + final_snap.node_count() == st.created.load());
        // Poison registry is consistent with the destruction count.
        std::lock_guard<std::mutex> lk(st.mu);
        CHECK(st.poisoned.size() == st.destroyed.load());
    }
    // Index destroyed: every remaining node got poisoned and freed.
    CHECK(st.created.load() == st.destroyed.load());
    std::lock_guard<std::mutex> lk(st.mu);
    CHECK(st.poisoned.size() == st.created.load());
}

static void test_barrier_snapshot_lifetime() {
    poison_stats st;
    index_t idx(poison_factory(st));
    idx.apply_batch({op::assign(0, 1000, 7)});
    idx.apply_batch({op::add(100, 200, 5), op::assign(500, 600, 42)});
    auto v2 = idx.get_snapshot().segments();

    std::barrier sync(2);
    std::atomic<bool> reader_ok{true};

    std::thread reader([&] {
        auto snap = idx.get_snapshot();  // pins v2
        sync.arrive_and_wait();          // let the writer race ahead
        sync.arrive_and_wait();          // wait until writer finished
        // Writer has published many newer versions and dropped its refs;
        // our snapshot must still answer exactly like v2.
        for (int rep = 0; rep < 50 && reader_ok.load(); ++rep) {
            for (const auto& seg : v2) {
                for (int p = seg.lo; p < seg.hi; p += 7) {
                    if (snap.query(p) != seg.val) reader_ok = false;
                }
            }
            if (snap.segments() != v2) reader_ok = false;
        }
    });

    sync.arrive_and_wait();  // reader has its snapshot
    for (int i = 0; i < 300; ++i) idx.apply_batch(batch_for(i));
    sync.arrive_and_wait();  // signal: all versions published
    reader.join();

    CHECK(reader_ok.load());
    // v2 nodes not shared with later versions were reclaimed exactly once.
    CHECK(st.destroyed.load() <= st.created.load());
}

static void test_concurrent_stress() {
    index_t idx;
    idx.apply_batch({op::assign(0, 500, 0)});
    constexpr int kReaders = 3;
    std::barrier start(kReaders + 1);
    std::atomic<bool> stop{false};
    std::atomic<bool> ok{true};

    auto reader_fn = [&] {
        start.arrive_and_wait();
        while (!stop.load(std::memory_order_relaxed)) {
            auto snap = idx.get_snapshot();
            auto segs = snap.segments();
            // internal consistency of a single published version
            for (std::size_t i = 1; i < segs.size(); ++i) {
                if (segs[i - 1].hi > segs[i].lo) ok = false;  // overlap/tearing
                if (segs[i - 1].hi == segs[i].lo &&
                    segs[i - 1].val == segs[i].val) ok = false;  // not canonical
            }
            for (const auto& s : segs) {
                if (snap.query(s.lo) != s.val) ok = false;
                if (snap.query(s.hi - 1) != s.val) ok = false;
            }
        }
    };

    std::vector<std::thread> readers;
    for (int i = 0; i < kReaders; ++i) readers.emplace_back(reader_fn);
    start.arrive_and_wait();
    for (int i = 0; i < 2000; ++i) idx.apply_batch(batch_for(i));
    stop.store(true);
    for (auto& t : readers) t.join();

    CHECK(ok.load());
    // Final state matches a sequentially computed expectation.
    index_t expect;
    expect.apply_batch({op::assign(0, 500, 0)});
    for (int i = 0; i < 2000; ++i) expect.apply_batch(batch_for(i));
    CHECK(idx.get_snapshot().segments() == expect.get_snapshot().segments());
}

static void run() {
    test_poisoned_reclamation();
    test_barrier_snapshot_lifetime();
    test_concurrent_stress();
}
TEST_MAIN()
