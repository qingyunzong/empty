// Differential test: the interval index is cross-checked against a
// small-array copy model.  The model stores one full copy of a tiny
// array per published version; every snapshot of the index must agree
// with the matching array copy at every point, for every version.
#include <interval_index/interval_index.hpp>

#include <array>
#include <optional>
#include <vector>

#include "test_util.hpp"

using interval_index::batch;
using interval_index::index;
using interval_index::segment;

namespace {

constexpr int kDomain = 96;
constexpr int kBatches = 400;

using model_t = std::array<std::optional<int>, kDomain>;

}  // namespace

int main() {
    rng r(20261005);
    index<int> idx;
    model_t model{};
    model.fill(std::nullopt);

    std::vector<index<int>::snapshot> snaps;   // one per published version
    std::vector<model_t> copies;               // small-array copy per version
    snaps.push_back(idx.snap());
    copies.push_back(model);

    for (int round = 0; round < kBatches; ++round) {
        batch<int> b;
        int ops = 1 + static_cast<int>(r.below(5));
        for (int k = 0; k < ops; ++k) {
            int lo = static_cast<int>(r.below(kDomain));
            int hi = lo + 1 + static_cast<int>(r.below(kDomain - lo));
            int v = static_cast<int>(r.below(21)) - 10;
            bool is_assign = r.below(2) == 0;
            if (is_assign) {
                b.assign(lo, hi, v);
                for (int x = lo; x < hi; ++x) model[x] = v;
            } else {
                b.add(lo, hi, v);
                for (int x = lo; x < hi; ++x)
                    if (model[x]) *model[x] += v;  // add never creates
            }
        }
        idx.apply(b);
        snaps.push_back(idx.snap());
        copies.push_back(model);

        // Spot-check the freshest snapshot right away.
        for (int probe = 0; probe < 8; ++probe) {
            int x = static_cast<int>(r.below(kDomain));
            CHECK_EQ(snaps.back().query(x), model[x]);
        }
    }

    // Full verification: every historical snapshot against its array copy.
    for (std::size_t v = 0; v < snaps.size(); ++v) {
        for (int x = 0; x < kDomain; ++x)
            CHECK_EQ(snaps[v].query(x), copies[v][x]);

        // Segment dump must expand exactly to the model array, with
        // coalesced (maximal) segments.
        auto segs = snaps[v].segments();
        std::size_t si = 0;
        for (int x = 0; x < kDomain; ++x) {
            if (!copies[v][x]) continue;
            CHECK(si < segs.size());
            CHECK(segs[si].lo <= x && x < segs[si].hi);
            CHECK_EQ(segs[si].value, *copies[v][x]);
            if (x + 1 == segs[si].hi) ++si;
        }
        CHECK(si == segs.size());
        for (std::size_t i = 1; i < segs.size(); ++i)
            CHECK(!(segs[i - 1].hi == segs[i].lo &&
                    segs[i - 1].value == segs[i].value));
    }

    std::printf("test_model: %d versions x %d points verified against "
                "small-array copy model\n",
                kBatches + 1, kDomain);
    return 0;
}
