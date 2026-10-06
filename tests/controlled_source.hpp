#pragma once

#include "kway_merge/merger.hpp"

#include <cstddef>
#include <memory>
#include <stdexcept>
#include <utility>
#include <vector>

// A scripted cursor for tests: yields a fixed key sequence, can be armed
// to throw on a chosen read, and counts next()/close() calls so tests can
// verify read pacing and exactly-once close semantics.
//
// The close count lives in a shared counter so tests can keep observing
// it after the cursor itself has been destroyed.
//
// value() returns the 0-based index of the current record within the
// source, which lets tests verify per-source order preservation.
class ControlledSource : public kway::Cursor<int, int> {
public:
    // fail_on_read: 0-based next() call index that throws instead of
    // advancing; -1 disables the failure.
    explicit ControlledSource(std::vector<int> keys, int fail_on_read = -1)
        : keys_(std::move(keys)), fail_on_read_(fail_on_read) {}

    bool next() override {
        ++reads_;
        if (fail_on_read_ >= 0 && static_cast<int>(reads_) - 1 == fail_on_read_) {
            throw std::runtime_error("controlled source failure");
        }
        if (!started_) {
            started_ = true;
        } else {
            ++pos_;
        }
        return pos_ < keys_.size();
    }

    const int& key() const override { return keys_[pos_]; }

    const int& value() const override {
        value_ = static_cast<int>(pos_);
        return value_;
    }

    void close() noexcept override { ++*close_count_; }

    std::size_t reads() const { return reads_; }
    int close_calls() const { return *close_count_; }
    std::shared_ptr<int> close_counter() const { return close_count_; }
    std::size_t size() const { return keys_.size(); }

private:
    std::vector<int> keys_;
    int fail_on_read_;
    std::size_t pos_ = 0;
    bool started_ = false;
    std::size_t reads_ = 0;
    std::shared_ptr<int> close_count_ = std::make_shared<int>(0);
    mutable int value_ = 0;
};
