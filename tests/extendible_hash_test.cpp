// Verification for dlks_formal::extendible_hash_directory.
//
// 1. Exhaustive split histories: every insertion sequence of length L over a
//    small key space {0..M-1} is replayed; after every single insert the whole
//    directory is checked against a naive modulo-addressing model.
// 2. Interleaved splits and lookups: a long pseudo-random mix of inserts and
//    finds, proving a lookup never touches the wrong bucket.
// 3. A dedicated overflow-page scenario at the depth cap.

#include "dlks_formal.hpp"

#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <map>
#include <optional>
#include <set>
#include <unordered_map>
#include <vector>

using dlks_formal::extendible_hash_directory;

static int g_failures = 0;

#define CHECK(cond, ...)                                                        \
    do {                                                                        \
        if (!(cond)) {                                                          \
            ++g_failures;                                                       \
            std::fprintf(stderr, "CHECK failed %s:%d: ", __FILE__, __LINE__);   \
            std::fprintf(stderr, __VA_ARGS__);                                  \
            std::fprintf(stderr, "\n");                                         \
            if (g_failures > 20)                                                \
                std::exit(1);                                                   \
        }                                                                       \
    } while (0)

struct identity_hash {
    std::size_t operator()(std::uint32_t k) const { return k; }
};

struct splitmix_hash {
    std::size_t operator()(std::uint32_t k) const {
        std::uint64_t z = k + 0x9e3779b97f4a7c15ull;
        z = (z ^ (z >> 30)) * 0xbf58476d1ce4e5b9ull;
        z = (z ^ (z >> 27)) * 0x94d049bb133111ebull;
        return static_cast<std::size_t>(z ^ (z >> 31));
    }
};

template <typename Hash>
using dir_t = extendible_hash_directory<std::uint32_t, std::uint32_t, Hash>;

// Full invariant audit of `dir` against the naive model:
// key k must live in the bucket addressed by hash(k) mod 2^global_depth.
template <typename Hash>
void verify(const dir_t<Hash>& dir,
            const std::unordered_map<std::uint32_t, std::uint32_t>& model,
            std::uint32_t key_space, Hash hash, std::size_t& prev_depth) {
    const std::size_t g = dir.global_depth();
    CHECK(g >= prev_depth, "global depth decreased: %zu -> %zu", prev_depth, g);
    prev_depth = g;
    CHECK(dir.directory_size() == (std::size_t{1} << g),
          "directory size %zu != 2^%zu", dir.directory_size(), g);
    CHECK(dir.size() == model.size(), "size %zu != model %zu", dir.size(),
          model.size());

    std::map<std::size_t, std::size_t> slots_of; // bucket id -> slot count
    for (std::size_t i = 0; i < dir.directory_size(); ++i)
        ++slots_of[dir.slot_owner(i)];

    std::size_t total_load = 0;
    std::size_t total_refcount = 0;
    std::multiset<std::uint32_t> stored;
    for (const auto& s : dir.stats()) {
        total_load += s.load;
        total_refcount += s.refcount;
        CHECK(s.local_depth <= g, "bucket %zu: local depth %zu > global %zu",
              s.id, s.local_depth, g);
        // Reference count: exact slot count, and exactly 2^(g - local_depth).
        CHECK(s.refcount == slots_of[s.id],
              "bucket %zu: refcount %zu != slot count %zu", s.id, s.refcount,
              slots_of[s.id]);
        CHECK(s.refcount == (std::size_t{1} << (g - s.local_depth)),
              "bucket %zu: refcount %zu != 2^(%zu-%zu)", s.id, s.refcount, g,
              s.local_depth);
        // Overflow pages are only allowed at the depth cap.
        if (s.overflow_pages > 0)
            CHECK(s.local_depth == dir.config().max_depth,
                  "bucket %zu: overflow below depth cap", s.id);

        // Every slot of this bucket must agree on the low local_depth bits.
        const std::size_t pmask = (std::size_t{1} << s.local_depth) - 1;
        std::optional<std::size_t> pattern;
        for (std::size_t i = 0; i < dir.directory_size(); ++i) {
            if (dir.slot_owner(i) != s.id)
                continue;
            const std::size_t p = i & pmask;
            if (!pattern.has_value())
                pattern = p;
            CHECK(*pattern == p, "bucket %zu: slots disagree on prefix", s.id);
        }
        // Every stored key must carry the bucket's addressing prefix.
        for (std::uint32_t k : dir.bucket_keys(s.id)) {
            CHECK((hash(k) & pmask) == *pattern,
                  "key %u in bucket %zu violates prefix partition", k, s.id);
            stored.insert(k);
        }
    }
    // Load conservation: nothing lost, nothing duplicated.
    CHECK(total_load == model.size(), "total load %zu != %zu keys", total_load,
          model.size());
    // Reference counts tile the whole directory.
    CHECK(total_refcount == dir.directory_size(), "refcounts sum to %zu != %zu",
          total_refcount, dir.directory_size());
    // Partition is disjoint and exhaustive w.r.t. the model.
    CHECK(stored.size() == model.size(), "stored multiset size %zu != %zu",
          stored.size(), model.size());
    for (const auto& [k, v] : model)
        CHECK(stored.count(k) == 1, "key %u stored %zu times", k,
              stored.count(k));

    // Per-key routing: naive modulo addressing vs. actual lookup probe.
    for (std::uint32_t k = 0; k < key_space; ++k) {
        const std::size_t naive = hash(k) % dir.directory_size();
        const std::uint32_t* got = dir.find(k);
        const auto pr = dir.last_probe();
        CHECK(pr.dir_index == naive, "key %u routed to slot %zu, naive says %zu",
              k, pr.dir_index, naive);
        CHECK(pr.dir_index == dir.directory_index(k),
              "key %u: probe slot %zu != directory_index %zu", k, pr.dir_index,
              dir.directory_index(k));
        CHECK(dir.slot_owner(pr.dir_index) == pr.bucket_id,
              "key %u: probe visited bucket %zu not owning slot %zu", k,
              pr.bucket_id, pr.dir_index);
        auto it = model.find(k);
        if (it == model.end()) {
            CHECK(got == nullptr, "phantom key %u found", k);
        } else {
            CHECK(got != nullptr && *got == it->second,
                  "key %u: lookup missed or wrong value", k);
        }
    }

    // Split history: depths monotone, each split re-partitioned a full bucket.
    std::size_t event_depth = 0;
    for (const auto& e : dir.split_history()) {
        CHECK(e.global_depth >= event_depth, "split history depth regressed");
        event_depth = e.global_depth;
        CHECK(e.kept + e.moved == dir.config().bucket_capacity,
              "split of bucket %zu: kept %zu + moved %zu != capacity %zu",
              e.bucket_id, e.kept, e.moved, dir.config().bucket_capacity);
        CHECK(e.global_depth <= g, "split event from the future");
    }
}

// Replays every sequence of `length` inserts over key space {0..M-1}.
template <typename Hash>
void exhaustive(std::uint32_t m, std::uint32_t length, std::size_t capacity,
                std::size_t max_depth, Hash hash, const char* tag) {
    typename dir_t<Hash>::options opts{capacity, max_depth};
    std::size_t sequences = 1;
    for (std::uint32_t i = 0; i < length; ++i)
        sequences *= m;
    std::vector<std::uint32_t> seq(length);
    for (std::size_t n = 0; n < sequences; ++n) {
        std::size_t x = n;
        for (auto& s : seq) {
            s = static_cast<std::uint32_t>(x % m);
            x /= m;
        }
        dir_t<Hash> dir(opts, hash);
        std::unordered_map<std::uint32_t, std::uint32_t> model;
        std::size_t depth = 0;
        for (std::uint32_t k : seq) {
            const std::uint32_t v = k * 7 + 1;
            const bool fresh = model.emplace(k, v).second;
            CHECK(dir.insert(k, v) == fresh, "%s: insert(%u) duplicate mismatch",
                  tag, k);
            verify(dir, model, m, hash, depth);
            if (g_failures > 0) {
                std::fprintf(stderr, "%s: aborting sequence %zu\n", tag, n);
                return;
            }
        }
    }
    std::printf("%s: %zu sequences x %u inserts verified (M=%u cap=%zu "
                "max_depth=%zu)\n",
                tag, sequences, length, m, capacity, max_depth);
}

// Long interleaving of splits and lookups against a running model.
void interleaved(std::uint32_t key_space, std::size_t ops, std::uint64_t seed) {
    dir_t<splitmix_hash> dir({4, 12}, splitmix_hash{});
    std::unordered_map<std::uint32_t, std::uint32_t> model;
    std::uint64_t rng = seed;
    auto next = [&] {
        rng += 0x9e3779b97f4a7c15ull;
        std::uint64_t z = rng;
        z = (z ^ (z >> 30)) * 0xbf58476d1ce4e5b9ull;
        z = (z ^ (z >> 27)) * 0x94d049bb133111ebull;
        return z ^ (z >> 31);
    };
    std::size_t depth = 0;
    std::size_t finds = 0;
    for (std::size_t op = 0; op < ops; ++op) {
        const std::uint32_t k = static_cast<std::uint32_t>(next() % key_space);
        if (next() % 3 == 0) { // insert
            const std::uint32_t v = static_cast<std::uint32_t>(next());
            const bool fresh = model.emplace(k, v).second;
            CHECK(dir.insert(k, v) == fresh, "interleaved: duplicate mismatch");
        } else { // lookup: probe must hit exactly the naive-modulo bucket
            ++finds;
            const std::uint32_t* got = dir.find(k);
            const auto pr = dir.last_probe();
            const std::size_t naive =
                splitmix_hash{}(k) % dir.directory_size();
            CHECK(pr.dir_index == naive,
                  "interleaved: key %u probed slot %zu, naive %zu", k,
                  pr.dir_index, naive);
            CHECK(dir.slot_owner(pr.dir_index) == pr.bucket_id,
                  "interleaved: key %u visited wrong bucket %zu", k,
                  pr.bucket_id);
            auto it = model.find(k);
            if (it == model.end())
                CHECK(got == nullptr, "interleaved: phantom key %u", k);
            else
                CHECK(got != nullptr && *got == it->second,
                      "interleaved: key %u missed", k);
        }
        if (op % 997 == 0)
            verify(dir, model, key_space, splitmix_hash{}, depth);
        if (g_failures > 0)
            return;
    }
    verify(dir, model, key_space, splitmix_hash{}, depth);
    std::printf("interleaved: %zu ops (%zu lookups), final depth %zu, %zu "
                "buckets, %zu keys\n",
                ops, finds, dir.global_depth(), dir.bucket_count(), dir.size());
}

// Forces overflow pages: many keys sharing the low max_depth hash bits.
void overflow_at_depth_cap() {
    dir_t<identity_hash> dir({2, 2}, identity_hash{});
    std::unordered_map<std::uint32_t, std::uint32_t> model;
    std::size_t depth = 0;
    for (std::uint32_t k = 0; k < 40; k += 4) { // all == 0 (mod 4)
        model.emplace(k, k + 100);
        CHECK(dir.insert(k, k + 100), "overflow: duplicate");
        verify(dir, model, 40, identity_hash{}, depth);
    }
    bool saw_overflow = false;
    for (const auto& s : dir.stats())
        if (s.overflow_pages > 0)
            saw_overflow = true;
    CHECK(saw_overflow, "overflow: expected overflow pages at the depth cap");
    CHECK(dir.global_depth() == 2, "overflow: depth %zu exceeded cap",
          dir.global_depth());
    std::printf("overflow: 10 colliding keys absorbed, depth capped at %zu\n",
                dir.global_depth());
}

int main() {
    // Exhaustive split histories over small key spaces.
    exhaustive(6, 7, 2, 4, identity_hash{}, "exhaustive/identity");
    exhaustive(8, 5, 1, 5, identity_hash{}, "exhaustive/tiny-buckets");
    exhaustive(7, 6, 2, 4, splitmix_hash{}, "exhaustive/splitmix");
    exhaustive(5, 6, 3, 3, identity_hash{}, "exhaustive/deep-cap");
    exhaustive(9, 5, 2, 6, splitmix_hash{}, "exhaustive/wide");

    // Interleaved splits and lookups.
    interleaved(/*key_space=*/512, /*ops=*/200000, /*seed=*/12345);
    interleaved(/*key_space=*/64, /*ops=*/100000, /*seed=*/777);

    // Overflow pages at the depth cap.
    overflow_at_depth_cap();

    if (g_failures != 0) {
        std::fprintf(stderr, "FAILED: %d check(s)\n", g_failures);
        return 1;
    }
    std::printf("all extendible-hash checks passed\n");
    return 0;
}
