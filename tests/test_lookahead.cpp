// Lookahead bound: at every observable point, each source has been read
// at most one record beyond what the merger has delivered from it, i.e.
// each source buffers at most one unconsumed record.
#include "model.hpp"

#include <random>

static void check_bound(const std::vector<ControlledSource*>& handles,
                        const std::vector<std::size_t>& delivered) {
    for (std::size_t i = 0; i < handles.size(); ++i) {
        CHECK(handles[i]->reads() <= delivered[i] + 1);
    }
}

static void test_bound_basic() {
    const std::vector<std::vector<int>> arrays = {
        {1, 4, 7},
        {2, 5},
        {3, 6, 8, 9},
    };
    std::vector<ControlledSource*> handles;
    auto merger = make_merger(arrays, handles);
    std::vector<std::size_t> delivered(arrays.size(), 0);

    check_bound(handles, delivered);
    for (;;) {
        auto result = merger->next();
        if (result.status == kway::Status::Done) {
            check_bound(handles, delivered);
            break;
        }
        CHECK(result.status == kway::Status::Ok);
        ++delivered[result.record->source]; // the returned record is delivered
        check_bound(handles, delivered);
    }

    // Fully drained sources were read exactly size + 1 times (the final
    // next() that reports exhaustion) and delivered everything.
    for (std::size_t i = 0; i < handles.size(); ++i) {
        CHECK(delivered[i] == arrays[i].size());
        CHECK(handles[i]->reads() == arrays[i].size() + 1);
    }
}

static void test_bound_with_pause_and_error() {
    const std::vector<std::vector<int>> arrays = {
        {1, 5, 9, 13},
        {2, 6, 10, 14}, // fails on read 2
        {3, 7, 11},
        {4, 8, 12, 16, 20},
    };
    constexpr int fail_source = 1;
    constexpr int fail_on_read = 2;
    std::vector<ControlledSource*> handles;
    auto merger = make_merger(arrays, handles, fail_source, fail_on_read);
    std::vector<std::size_t> delivered(arrays.size(), 0);

    int step = 0;
    for (;;) {
        if (step % 3 == 1) { // periodically pause/resume around a read
            merger->pause();
            CHECK(merger->next().status == kway::Status::Paused);
            check_bound(handles, delivered);
            merger->resume();
        }
        auto result = merger->next();
        if (result.status == kway::Status::Done) {
            check_bound(handles, delivered);
            break;
        }
        if (result.status == kway::Status::SourceError) {
            CHECK(result.error_source == fail_source);
        } else {
            CHECK(result.status == kway::Status::Ok);
            ++delivered[result.record->source];
        }
        check_bound(handles, delivered);
        ++step;
    }

    for (std::size_t i = 0; i < handles.size(); ++i) {
        if (static_cast<int>(i) == fail_source) {
            CHECK(handles[i]->reads() == fail_on_read + 1);
            CHECK(delivered[i] == static_cast<std::size_t>(fail_on_read));
        } else {
            CHECK(handles[i]->reads() == arrays[i].size() + 1);
            CHECK(delivered[i] == arrays[i].size());
        }
    }
}

static void test_bound_fuzz() {
    std::mt19937 rng(424242);
    for (int iteration = 0; iteration < 200; ++iteration) {
        const int k = 1 + static_cast<int>(rng() % 7);
        std::vector<std::vector<int>> arrays(k);
        for (auto& array : arrays) {
            const int n = static_cast<int>(rng() % 30);
            int key = 0;
            for (int i = 0; i < n; ++i) {
                key += static_cast<int>(rng() % 4);
                array.push_back(key);
            }
        }
        std::vector<ControlledSource*> handles;
        auto merger = make_merger(arrays, handles);
        std::vector<std::size_t> delivered(arrays.size(), 0);
        for (;;) {
            auto result = merger->next();
            if (result.status == kway::Status::Done) {
                check_bound(handles, delivered);
                break;
            }
            CHECK(result.status == kway::Status::Ok);
            ++delivered[result.record->source];
            check_bound(handles, delivered);
        }
    }
}

int main() {
    test_bound_basic();
    test_bound_with_pause_and_error();
    test_bound_fuzz();
    return 0;
}
