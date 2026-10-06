// Full-array model verification: merged output must equal the sorted
// concatenation of all inputs, ordered by (key, source).
#include "model.hpp"

#include <random>

static void test_empty_input() {
    std::vector<ControlledSource*> handles;
    auto merger = make_merger({}, handles);
    CHECK(merger->next().status == kway::Status::Done);
}

static void test_all_sources_empty() {
    std::vector<ControlledSource*> handles;
    auto merger = make_merger({{}, {}, {}}, handles);
    CHECK(merger->next().status == kway::Status::Done);
    for (const auto* source : handles) {
        CHECK(source->close_calls() == 1);
    }
}

static void test_single_source() {
    std::vector<ControlledSource*> handles;
    auto merger = make_merger({{1, 2, 2, 7, 9}}, handles);
    check_against_model(*merger, {{1, 2, 2, 7, 9}});
}

static void test_duplicate_keys_across_sources() {
    const std::vector<std::vector<int>> arrays = {
        {1, 3, 5},
        {1, 3, 5},
        {1, 3, 5},
    };
    std::vector<ControlledSource*> handles;
    auto merger = make_merger(arrays, handles);
    check_against_model(*merger, arrays);
}

static void test_mixed_with_empty_sources() {
    const std::vector<std::vector<int>> arrays = {
        {},
        {2, 4},
        {},
        {1, 5},
        {},
    };
    std::vector<ControlledSource*> handles;
    auto merger = make_merger(arrays, handles);
    check_against_model(*merger, arrays);
}

static void test_fuzz_against_model() {
    std::mt19937 rng(20261007);
    for (int iteration = 0; iteration < 300; ++iteration) {
        const int k = 1 + static_cast<int>(rng() % 9);
        std::vector<std::vector<int>> arrays(k);
        for (auto& array : arrays) {
            const int n = static_cast<int>(rng() % 60);
            int key = static_cast<int>(rng() % 4);
            for (int i = 0; i < n; ++i) {
                key += static_cast<int>(rng() % 5); // non-decreasing
                array.push_back(key);
            }
        }
        std::vector<ControlledSource*> handles;
        auto merger = make_merger(arrays, handles);
        check_against_model(*merger, arrays);
    }
}

int main() {
    test_empty_input();
    test_all_sources_empty();
    test_single_source();
    test_duplicate_keys_across_sources();
    test_mixed_with_empty_sources();
    test_fuzz_against_model();
    return 0;
}
