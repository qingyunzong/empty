#include "spatial/index.hpp"

#include <algorithm>
#include <cstdint>
#include <random>
#include <unordered_map>
#include <utility>
#include <vector>

#include "test_framework.hpp"

using spatial::Box;

// Brute-force full-scan reference model: the ground truth every index
// query is checked against.
template <std::size_t Dims>
static std::vector<std::uint64_t> model_query(
    const std::unordered_map<std::uint64_t, Box<Dims>>& model, const Box<Dims>& q) {
    std::vector<std::uint64_t> out;
    for (const auto& [id, box] : model)
        if (spatial::intersects(box, q)) out.push_back(id);
    std::sort(out.begin(), out.end());
    return out;
}

template <std::size_t Dims>
static void expect_view_matches_model(
    const typename spatial::SpatialIndex<Dims>::View& view,
    const std::unordered_map<std::uint64_t, Box<Dims>>& model, const Box<Dims>& q) {
    auto got = view.query(q);
    std::sort(got.begin(), got.end());
    CHECK(got == model_query(model, q));
}

template <std::size_t Dims>
class RandomWorld {
public:
    using Index = spatial::SpatialIndex<Dims>;
    using Model = std::unordered_map<std::uint64_t, Box<Dims>>;

    explicit RandomWorld(std::uint64_t seed, std::uint64_t id_space, int coord_max)
        : rng_(seed), id_space_(id_space), coord_max_(coord_max) {}

    Box<Dims> random_box(int max_extent) {
        Box<Dims> b;
        for (std::size_t d = 0; d < Dims; ++d) {
            const int lo = coord();
            // extent 0 occurs naturally -> zero-volume boxes in the mix
            const int hi = lo + static_cast<int>(rng_() % (max_extent + 1));
            b.min[d] = lo;
            b.max[d] = hi;
        }
        return b;
    }

    // One random batch, applied to both the index and the model.
    void commit_round(std::size_t max_ops) {
        std::vector<typename Index::Op> ops;
        const std::size_t n = 1 + rng_() % max_ops;
        for (std::size_t i = 0; i < n; ++i) {
            const std::uint64_t id = rng_() % id_space_;
            if (rng_() % 5 == 0) {
                ops.push_back(typename Index::Remove{id});
                model_.erase(id);
            } else {
                Box<Dims> b = random_box(8);
                ops.push_back(typename Index::Upsert{id, b});
                if (!b.empty()) model_[id] = b;  // zero volume: ignored
            }
        }
        idx_.commit(ops);
    }

    void verify_current(std::size_t num_queries) {
        auto view = idx_.open_view();
        CHECK_EQ(view.size(), model_.size());
        for (std::size_t i = 0; i < num_queries; ++i)
            expect_view_matches_model<Dims>(view, model_, random_box(30));
    }

    void pin_snapshot() { pinned_.push_back(Pinned{idx_.open_view(), model_}); }

    void verify_pinned() {
        for (auto& p : pinned_) {
            CHECK_EQ(p.view.size(), p.model.size());
            for (int i = 0; i < 2; ++i)
                expect_view_matches_model<Dims>(p.view, p.model, random_box(30));
        }
    }

private:
    struct Pinned {
        typename Index::View view;
        Model model;
    };

    int coord() { return static_cast<int>(rng_() % (coord_max_ + 1)); }

    std::mt19937_64 rng_;
    std::uint64_t id_space_;
    int coord_max_;
    Index idx_;
    Model model_;
    std::vector<Pinned> pinned_;
};

TF_TEST(randomized_index_matches_full_scan_2d) {
    // Integer coordinates on a small grid make boundary-touching boxes
    // frequent, exercising the half-open semantics hard.
    RandomWorld<2> world(42, 300, 60);
    for (int round = 0; round < 40; ++round) {
        world.commit_round(40);
        world.verify_current(30);
        if (round % 5 == 0) world.pin_snapshot();  // keep old views alive
        world.verify_pinned();  // old views must still match their old models
    }
}

TF_TEST(randomized_index_matches_full_scan_3d) {
    RandomWorld<3> world(1337, 150, 40);
    for (int round = 0; round < 15; ++round) {
        world.commit_round(30);
        world.verify_current(20);
        if (round % 4 == 0) world.pin_snapshot();
        world.verify_pinned();
    }
}

TF_MAIN()
