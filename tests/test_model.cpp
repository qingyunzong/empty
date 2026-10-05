// Differential test: randomized batches cross-checked against a small
// copy-model (a plain array of optional values), after every single batch.
#include "interval_index.hpp"
#include "check.hpp"

#include <array>
#include <cstdint>
#include <optional>
#include <random>
#include <vector>

using index_t = iix::interval_index<int, std::int64_t>;
using op = index_t::op;
using segment = index_t::snapshot::segment;

static constexpr int N = 64;  // small array model over points [0, N)
using model_t = std::array<std::optional<std::int64_t>, N>;

static void apply_to_model(model_t& m, const op& o) {
    for (int p = o.lo; p < o.hi; ++p) {
        if (p < 0 || p >= N) continue;
        switch (o.kind) {
            case index_t::op_kind::assign: m[p] = o.val; break;
            case index_t::op_kind::add: m[p] = m[p].value_or(0) + o.val; break;
            case index_t::op_kind::erase: m[p] = std::nullopt; break;
        }
    }
}

static std::vector<segment> model_segments(const model_t& m) {
    std::vector<segment> out;
    for (int p = 0; p < N;) {
        if (!m[p]) { ++p; continue; }
        int start = p;
        std::int64_t v = *m[p];
        while (p < N && m[p] && *m[p] == v) ++p;
        out.push_back({start, p, v});
    }
    return out;
}

static void run() {
    std::mt19937_64 rng(20261006ULL);
    for (int round = 0; round < 30; ++round) {
        index_t idx;
        model_t model{};
        for (int batch = 0; batch < 120; ++batch) {
            std::vector<op> ops;
            int nops = 1 + static_cast<int>(rng() % 6);
            for (int i = 0; i < nops; ++i) {
                int a = static_cast<int>(rng() % (N + 1));  // keep ops inside [0, N]
                int b = a + static_cast<int>(rng() % (N - a + 1));
                std::int64_t v = static_cast<std::int64_t>(rng() % 9) - 4;
                switch (rng() % 10) {
                    case 0: case 1: ops.push_back(op::erase(a, b)); break;
                    case 2: case 3: case 4: case 5: ops.push_back(op::add(a, b, v)); break;
                    default: ops.push_back(op::assign(a, b, v)); break;
                }
            }
            idx.apply_batch(ops);                 // same ops, same order ...
            for (const op& o : ops) apply_to_model(model, o);  // ... in the model

            auto snap = idx.get_snapshot();
            // 1) point queries match the model (inside and outside [0, N))
            for (int p = -4; p < N + 4; ++p) {
                auto got = snap.query(p);
                std::optional<std::int64_t> want =
                    (p >= 0 && p < N) ? model[p] : std::nullopt;
                CHECK_MSG(got == want, "round %d batch %d point %d", round, batch, p);
            }
            // 2) exact canonical segment list matches the model's
            auto got_segs = snap.segments();
            auto want_segs = model_segments(model);
            CHECK_MSG(got_segs == want_segs,
                      "round %d batch %d: segment list mismatch (%zu vs %zu)",
                      round, batch, got_segs.size(), want_segs.size());
            // 3) canonical form: sorted, disjoint, adjacent values differ
            for (std::size_t i = 1; i < got_segs.size(); ++i) {
                CHECK(got_segs[i - 1].hi <= got_segs[i].lo);
                CHECK(got_segs[i - 1].hi != got_segs[i].lo ||
                      got_segs[i - 1].val != got_segs[i].val);
            }
        }
    }
}
TEST_MAIN()
