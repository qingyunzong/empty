// Pause support: while paused, next() reports Paused and no source is
// read; resume() continues the merge exactly where it left off.
#include "model.hpp"

static void test_pause_before_first_read() {
    const std::vector<std::vector<int>> arrays = {{1, 4}, {2, 5}, {3, 6}};
    std::vector<ControlledSource*> handles;
    auto merger = make_merger(arrays, handles);

    merger->pause();
    for (int i = 0; i < 3; ++i) {
        CHECK(merger->next().status == kway::Status::Paused);
    }
    for (const auto* source : handles) {
        CHECK(source->reads() == 0); // lazy priming: nothing touched yet
    }

    merger->resume();
    check_against_model(*merger, arrays);
}

static void test_pause_mid_stream() {
    const std::vector<std::vector<int>> arrays = {
        {1, 4, 7, 10},
        {2, 5, 8, 11},
        {3, 6, 9, 12},
    };
    std::vector<ControlledSource*> handles;
    auto merger = make_merger(arrays, handles);

    std::vector<kway::Record<int, int>> prefix;
    for (int i = 0; i < 5; ++i) {
        auto result = merger->next();
        CHECK(result.status == kway::Status::Ok);
        prefix.push_back(*result.record);
    }

    merger->pause();
    std::vector<std::size_t> reads_at_pause;
    for (const auto* source : handles) {
        reads_at_pause.push_back(source->reads());
    }
    for (int i = 0; i < 4; ++i) {
        CHECK(merger->next().status == kway::Status::Paused);
    }
    for (std::size_t i = 0; i < handles.size(); ++i) {
        CHECK(handles[i]->reads() == reads_at_pause[i]); // no reads while paused
    }

    merger->resume();
    std::vector<kway::Record<int, int>> suffix;
    for (;;) {
        auto result = merger->next();
        if (result.status == kway::Status::Done) {
            break;
        }
        CHECK(result.status == kway::Status::Ok);
        suffix.push_back(*result.record);
    }

    const auto expected = model_merge(arrays);
    CHECK(prefix.size() + suffix.size() == expected.size());
    std::size_t index = 0;
    for (const auto& record : prefix) {
        CHECK(record.key == expected[index].first);
        CHECK(static_cast<int>(record.source) == expected[index].second);
        ++index;
    }
    for (const auto& record : suffix) {
        CHECK(record.key == expected[index].first);
        CHECK(static_cast<int>(record.source) == expected[index].second);
        ++index;
    }
}

static void test_pause_idempotent_and_toggle() {
    std::vector<ControlledSource*> handles;
    auto merger = make_merger({{1}, {2}}, handles);
    merger->pause();
    merger->pause();
    CHECK(merger->paused());
    CHECK(merger->next().status == kway::Status::Paused);
    merger->resume();
    CHECK(!merger->paused());
    merger->resume();
    CHECK(merger->next().status == kway::Status::Ok);
}

int main() {
    test_pause_before_first_read();
    test_pause_mid_stream();
    test_pause_idempotent_and_toggle();
    return 0;
}
