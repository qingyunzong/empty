// Source error reporting: a failing source is reported with its source
// number, closed exactly once, and dropped; the merge continues with the
// remaining sources.
#include "model.hpp"

static void test_error_mid_stream() {
    const std::vector<std::vector<int>> arrays = {
        {1, 4, 7},
        {2, 5, 8, 11}, // fails on read 2: delivers 2, 5, then throws
        {3, 6, 9},
    };
    std::vector<ControlledSource*> handles;
    auto merger = make_merger(arrays, handles, /*fail_source=*/1, /*fail_on_read=*/2);

    // Expected stream: full merge of the arrays with source 1 truncated
    // to the two records delivered before the failure.
    const auto expected = model_merge({{1, 4, 7}, {2, 5}, {3, 6, 9}});

    std::size_t produced = 0;
    int error_count = 0;
    for (;;) {
        auto result = merger->next();
        if (result.status == kway::Status::Done) {
            break;
        }
        if (result.status == kway::Status::SourceError) {
            ++error_count;
            CHECK(result.error_source == 1);
            CHECK(result.error != nullptr);
            bool is_runtime_error = false;
            try {
                std::rethrow_exception(result.error);
            } catch (const std::runtime_error&) {
                is_runtime_error = true;
            }
            CHECK(is_runtime_error);
            continue;
        }
        CHECK(result.status == kway::Status::Ok);
        CHECK(produced < expected.size());
        CHECK(result.record->key == expected[produced].first);
        CHECK(static_cast<int>(result.record->source) == expected[produced].second);
        ++produced;
    }
    CHECK(error_count == 1);
    CHECK(produced == expected.size());

    // The failed source was read exactly up to the failing call and
    // closed exactly once; healthy sources were fully drained and closed.
    CHECK(handles[1]->reads() == 3);
    for (const auto* source : handles) {
        CHECK(source->close_calls() == 1);
    }
}

static void test_error_during_priming() {
    const std::vector<std::vector<int>> arrays = {
        {1, 3}, // fails on the very first read
        {2, 4},
    };
    std::vector<ControlledSource*> handles;
    auto merger = make_merger(arrays, handles, /*fail_source=*/0, /*fail_on_read=*/0);

    auto first = merger->next();
    CHECK(first.status == kway::Status::SourceError);
    CHECK(first.error_source == 0);

    const auto expected = model_merge({{}, {2, 4}});
    std::size_t produced = 0;
    for (;;) {
        auto result = merger->next();
        if (result.status == kway::Status::Done) {
            break;
        }
        CHECK(result.status == kway::Status::Ok);
        CHECK(result.record->key == expected[produced].first);
        CHECK(static_cast<int>(result.record->source) == expected[produced].second);
        ++produced;
    }
    CHECK(produced == expected.size());
    for (const auto* source : handles) {
        CHECK(source->close_calls() == 1);
    }
}

static void test_all_sources_fail() {
    const std::vector<std::vector<int>> arrays = {{5}, {6}, {7}};
    std::vector<std::unique_ptr<kway::Cursor<int, int>>> cursors;
    std::vector<ControlledSource*> handles;
    for (const auto& array : arrays) {
        auto source = std::make_unique<ControlledSource>(array, /*fail_on_read=*/0);
        handles.push_back(source.get());
        cursors.push_back(std::move(source));
    }
    kway::Merger<int, int> merger(std::move(cursors));

    for (int i = 0; i < 3; ++i) {
        auto result = merger.next();
        CHECK(result.status == kway::Status::SourceError);
        CHECK(result.error_source == static_cast<std::size_t>(i));
    }
    CHECK(merger.next().status == kway::Status::Done);
    for (const auto* source : handles) {
        CHECK(source->close_calls() == 1);
    }
}

int main() {
    test_error_mid_stream();
    test_error_during_priming();
    test_all_sources_fail();
    return 0;
}
