// Snapshots and batch updates: old snapshots stay queryable, source diffs are
// reported even when the height itself does not change.
#include "skyline/skyline.hpp"
#include "check.hpp"

using namespace skyline;

int main() {
    Skyline s;
    s.add({1, 0, 10, 5});
    s.add({2, 2, 8, 7});
    auto v1 = s.snapshot();

    // Batch: remove 2, add 3 and 4 in one commit.
    auto v2 = s.applyBatch(/*adds=*/{{3, 4, 12, 6}, {4, 20, 25, 3}},
                           /*removes=*/{2});

    // Old snapshot is still fully queryable.
    {
        std::vector<ChangePoint> want = {{0, 5}, {2, 7}, {8, 5}, {10, 0}};
        CHECK_EQ(s.skyline(v1), want);
        std::vector<Segment> segs = {
            {0, 2, 5, {1}}, {2, 8, 7, {2}}, {8, 10, 5, {1}},
        };
        CHECK_EQ(s.topSegments(v1, 0, 10), segs);
    }
    // Current state reflects the batch.
    {
        std::vector<ChangePoint> want = {
            {0, 5}, {4, 6}, {12, 0}, {20, 3}, {25, 0},
        };
        CHECK_EQ(s.skyline(), want);
        CHECK_EQ(s.skyline(), s.skyline(v2));
    }

    // Source diff between snapshots, per maximal changed segment.
    {
        std::vector<SourceChange> want = {
            {2, 4, 7, 5, {2}, {1}},
            {4, 8, 7, 6, {2}, {3}},
            {8, 10, 5, 6, {1}, {3}},
            {10, 12, 0, 6, {}, {3}},
            {20, 25, 0, 3, {}, {4}},
        };
        CHECK_EQ(Skyline::diffSources(v1, v2), want);
    }

    // Height-unchanged source swap must still be notified.
    {
        Skyline t;
        t.add({1, 0, 10, 5});
        auto a = t.snapshot();
        auto b = t.applyBatch(/*adds=*/{{2, 0, 10, 5}}, /*removes=*/{1});
        // Skyline identical...
        std::vector<ChangePoint> same = {{0, 5}, {10, 0}};
        CHECK_EQ(t.skyline(a), same);
        CHECK_EQ(t.skyline(b), same);
        // ...but the source changed, so a diff is emitted.
        std::vector<SourceChange> want = {{0, 10, 5, 5, {1}, {2}}};
        auto diff = Skyline::diffSources(a, b);
        CHECK_EQ(diff, want);
        CHECK(!diff[0].heightChanged());
    }

    // Identical snapshots produce no changes.
    CHECK(Skyline::diffSources(v2, v2).empty());

    // Batch with only removals; empty skyline afterwards.
    {
        Skyline t;
        t.add({1, 0, 4, 2});
        auto a = t.snapshot();
        auto b = t.applyBatch({}, {1});
        CHECK(t.skyline(b).empty());
        std::vector<SourceChange> want = {{0, 4, 2, 0, {1}, {}}};
        CHECK_EQ(Skyline::diffSources(a, b), want);
    }

    // remove(vector) reports how many were actually erased.
    {
        Skyline t;
        t.add({1, 0, 4, 2});
        t.add({2, 5, 9, 2});
        CHECK_EQ(t.remove(std::vector<RectId>{1, 2, 99}), 2u);
        CHECK(t.skyline().empty());
    }

    return 0;
}
