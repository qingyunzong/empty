#pragma once

#include "check.hpp"
#include "controlled_source.hpp"

#include <algorithm>
#include <cstddef>
#include <memory>
#include <utility>
#include <vector>

// Builds a merger over controlled sources and hands back raw observation
// handles (the merger owns the sources).
inline std::unique_ptr<kway::Merger<int, int>>
make_merger(const std::vector<std::vector<int>>& arrays,
            std::vector<ControlledSource*>& handles, int fail_source = -1,
            int fail_on_read = -1) {
    std::vector<std::unique_ptr<kway::Cursor<int, int>>> cursors;
    for (std::size_t i = 0; i < arrays.size(); ++i) {
        const int arm = static_cast<int>(i) == fail_source ? fail_on_read : -1;
        auto source = std::make_unique<ControlledSource>(arrays[i], arm);
        handles.push_back(source.get());
        cursors.push_back(std::move(source));
    }
    return std::make_unique<kway::Merger<int, int>>(std::move(cursors));
}

// Reference model: concatenate everything, sort by (key, source).
inline std::vector<std::pair<int, int>>
model_merge(const std::vector<std::vector<int>>& arrays) {
    std::vector<std::pair<int, int>> all;
    for (std::size_t i = 0; i < arrays.size(); ++i) {
        for (const int key : arrays[i]) {
            all.emplace_back(key, static_cast<int>(i));
        }
    }
    std::sort(all.begin(), all.end());
    return all;
}

// Drains the merger and checks the stream against the model, including
// per-source value order (values must be 0,1,2,... per source).
inline void check_against_model(kway::Merger<int, int>& merger,
                                const std::vector<std::vector<int>>& arrays) {
    const auto expected = model_merge(arrays);
    std::vector<int> next_value(arrays.size(), 0);
    std::size_t produced = 0;
    for (;;) {
        auto result = merger.next();
        if (result.status == kway::Status::Done) {
            break;
        }
        CHECK(result.status == kway::Status::Ok);
        CHECK(produced < expected.size());
        CHECK(result.record->key == expected[produced].first);
        CHECK(static_cast<int>(result.record->source) == expected[produced].second);
        CHECK(result.record->value == next_value[result.record->source]++);
        ++produced;
    }
    CHECK(produced == expected.size());
}
