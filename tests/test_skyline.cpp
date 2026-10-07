// Skyline basics: half-open intervals, negative coords, zero height = empty,
// id-targeted deletion, adjacent same-height merging.
#include "skyline/skyline.hpp"
#include "check.hpp"

using namespace skyline;

int main() {
    // Classic two-rectangle skyline.
    {
        Skyline s;
        s.add({1, 2, 5, 10});
        s.add({2, 4, 8, 6});
        std::vector<ChangePoint> want = {
            {2, 10}, {5, 6}, {8, 0},
        };
        CHECK_EQ(s.skyline(), want);
    }

    // Negative coordinates and half-open adjacency (no overlap at shared edge).
    {
        Skyline s;
        s.add({1, -10, -3, 5});
        s.add({2, -3, 4, 5}); // touches at x=-3, same height -> merged
        std::vector<ChangePoint> want = {{-10, 5}, {4, 0}};
        CHECK_EQ(s.skyline(), want);
    }

    // Height zero / inverted intervals are empty and never appear.
    {
        Skyline s;
        s.add({1, 0, 10, 0});   // zero height: empty
        s.add({2, 5, 5, 7});    // zero width: empty
        s.add({3, 9, 2, 7});    // inverted: empty
        CHECK(s.skyline().empty());
        s.add({4, 1, 3, 4});
        std::vector<ChangePoint> want = {{1, 4}, {3, 0}};
        CHECK_EQ(s.skyline(), want);
    }

    // Deletion removes only the deleted rect's contribution:
    // the occluded lower rect becomes visible again.
    {
        Skyline s;
        s.add({1, 0, 10, 3});
        s.add({2, 2, 8, 9});
        s.add({3, 4, 6, 6});
        CHECK(s.remove(2));
        std::vector<ChangePoint> want = {
            {0, 3}, {4, 6}, {6, 3}, {10, 0},
        };
        CHECK_EQ(s.skyline(), want);
        CHECK(!s.remove(42)); // unknown id
    }

    // Same-height stacked rects: removing one keeps height, no phantom points.
    {
        Skyline s;
        s.add({1, 0, 5, 7});
        s.add({2, 0, 5, 7});
        s.add({3, 5, 9, 7}); // adjacent same height merges into one run
        std::vector<ChangePoint> want = {{0, 7}, {9, 0}};
        CHECK_EQ(s.skyline(), want);
        CHECK(s.remove(1));
        CHECK_EQ(s.skyline(), want); // id 2 still holds the height
        CHECK(s.remove(2));
        std::vector<ChangePoint> want2 = {{5, 7}, {9, 0}};
        CHECK_EQ(s.skyline(), want2);
    }

    // Upsert: re-adding an id replaces its previous contribution.
    {
        Skyline s;
        s.add({1, 0, 10, 4});
        s.add({1, 0, 10, 8});
        std::vector<ChangePoint> want = {{0, 8}, {10, 0}};
        CHECK_EQ(s.skyline(), want);
    }

    // Events at the same x collapse; no zero-width artifacts.
    {
        Skyline s;
        s.add({1, 0, 5, 5});
        s.add({2, 5, 10, 3});
        std::vector<ChangePoint> want = {{0, 5}, {5, 3}, {10, 0}};
        CHECK_EQ(s.skyline(), want);
    }

    return 0;
}
