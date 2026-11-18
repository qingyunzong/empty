#pragma once

#include <algorithm>
#include <cstddef>
#include <deque>
#include <functional>
#include <iterator>
#include <optional>
#include <queue>
#include <stdexcept>
#include <utility>
#include <vector>

namespace dlks_formal {

// Embeddable external sort component (C++20, header-only).
//
// Sorted runs are generated under a memory budget: the run buffer holds at
// most `memory_budget` elements, so run split points are fully determined by
// the budget (every flushed run has exactly `memory_budget` elements except
// possibly the last one). Runs are combined by a stable k-way merge
// (fan-in == memory_budget input buffers); equal keys are ordered by the
// sequence number of their source run, which preserves the original input
// order. Merge passes are interleaved with run generation: as soon as
// `fan_in` runs are pending, the oldest ones are merged into a single run.
//
// The merged run inherits the smallest sequence number of its inputs. Since
// base runs partition the input in arrival order, an older run's elements
// always win key ties against a younger run's elements, which is exactly
// stability with respect to the original input order.
template <class T, class Compare = std::less<T>>
class external_sorter {
    struct run {
        std::size_t seq;      // sequence number of the oldest constituent run
        std::vector<T> items; // sorted according to Compare
    };

public:
    explicit external_sorter(std::size_t memory_budget, Compare cmp = Compare{})
        : budget_(memory_budget), fan_in_(memory_budget), cmp_(std::move(cmp)) {
        if (budget_ < 2) {
            throw std::invalid_argument(
                "external_sorter: memory budget must be >= 2 "
                "(one run buffer slot plus at least one merge input buffer)");
        }
        buffer_.reserve(budget_);
    }

    external_sorter(const external_sorter&) = delete;
    external_sorter& operator=(const external_sorter&) = delete;

    // Feed one element. Flushes a sorted run whenever the budget is reached
    // and eagerly merges while at least `fan_in` runs are pending.
    void push(const T& value) {
        buffer_.push_back(value);
        if (buffer_.size() == budget_) flush_buffer();
    }
    void push(T&& value) {
        buffer_.push_back(std::move(value));
        if (buffer_.size() == budget_) flush_buffer();
    }

    template <std::input_iterator It>
    void push_range(It first, It last) {
        for (; first != last; ++first) push(*first);
    }

    // Signal end of input: flush the partial tail run and reduce all pending
    // runs to a single sorted run.
    void finish() {
        if (finished_) return;
        flush_buffer();
        while (runs_.size() > 1) {
            const std::size_t group_size =
                runs_.size() < fan_in_ ? runs_.size() : fan_in_;
            merge_oldest(group_size);
        }
        finished_ = true;
    }

    // Pull-style output. Implies finish() on first call.
    std::optional<T> next() {
        if (!finished_) finish();
        if (runs_.empty() || out_pos_ >= runs_.front().items.size())
            return std::nullopt;
        return runs_.front().items[out_pos_++];
    }

    // Push-style output. Implies finish().
    template <std::output_iterator<T> Out>
    void drain(Out out) {
        if (!finished_) finish();
        if (runs_.empty()) return;
        auto& items = runs_.front().items;
        std::move(items.begin() + static_cast<std::ptrdiff_t>(out_pos_),
                  items.end(), out);
        out_pos_ = items.size();
    }

    // Introspection (useful for tests and embedders).
    std::size_t memory_budget() const { return budget_; }
    std::size_t merge_fan_in() const { return fan_in_; }
    std::size_t pending_runs() const { return runs_.size(); }
    std::size_t buffered() const { return buffer_.size(); }
    std::size_t elements_in_runs() const {
        std::size_t total = 0;
        for (const auto& r : runs_) total += r.items.size();
        return total;
    }
    // Sizes of the runs as they were generated, in generation order.
    const std::vector<std::size_t>& generated_run_sizes() const {
        return generated_run_sizes_;
    }

private:
    void flush_buffer() {
        if (buffer_.empty()) return;
        std::stable_sort(buffer_.begin(), buffer_.end(), cmp_);
        generated_run_sizes_.push_back(buffer_.size());
        run r;
        r.seq = next_seq_++;
        r.items = std::move(buffer_);
        buffer_.clear();
        buffer_.reserve(budget_);
        runs_.push_back(std::move(r));
        // Interleave merging with run generation to keep the number of
        // pending runs below the fan-in.
        while (runs_.size() >= fan_in_) merge_oldest(fan_in_);
    }

    // Merge the `count` oldest pending runs into one run placed at their
    // position. The merged run keeps the oldest sequence number so that key
    // ties against younger runs resolve in favour of the older input.
    void merge_oldest(std::size_t count) {
        std::vector<run> group;
        group.reserve(count);
        for (std::size_t i = 0; i < count; ++i) {
            group.push_back(std::move(runs_.front()));
            runs_.pop_front();
        }
        runs_.insert(runs_.begin(), merge_group(group));
    }

    // Stable k-way merge of `group` (ordered by ascending sequence number).
    run merge_group(std::vector<run>& group) {
        run out;
        out.seq = group.front().seq;
        std::size_t total = 0;
        for (const auto& r : group) total += r.items.size();
        out.items.reserve(total);
        if (group.size() == 1) {
            out.items = std::move(group.front().items);
            return out;
        }
        struct node {
            const T* item;
            std::size_t run_idx;
            std::size_t pos;
        };
        // priority_queue keeps the "largest" element on top; define later-than
        // so the smallest node (by key, then by source run order) pops first.
        auto later_than = [this](const node& a, const node& b) {
            if (cmp_(*b.item, *a.item)) return true;  // b's key smaller
            if (cmp_(*a.item, *b.item)) return false; // a's key smaller
            return a.run_idx > b.run_idx;             // tie: older run first
        };
        std::priority_queue<node, std::vector<node>, decltype(later_than)>
            heap(later_than);
        for (std::size_t i = 0; i < group.size(); ++i) {
            if (!group[i].items.empty())
                heap.push(node{&group[i].items[0], i, 0});
        }
        while (!heap.empty()) {
            node n = heap.top();
            heap.pop();
            out.items.push_back(*n.item);
            if (++n.pos < group[n.run_idx].items.size()) {
                n.item = &group[n.run_idx].items[n.pos];
                heap.push(n);
            }
        }
        return out;
    }

    std::size_t budget_;
    std::size_t fan_in_;
    Compare cmp_;
    std::vector<T> buffer_;
    std::deque<run> runs_;
    std::size_t next_seq_ = 0;
    std::size_t out_pos_ = 0;
    bool finished_ = false;
    std::vector<std::size_t> generated_run_sizes_;
};

// One-shot convenience wrapper.
template <std::input_iterator In, std::output_iterator<std::iter_value_t<In>> Out,
          class Compare = std::less<std::iter_value_t<In>>>
void external_sort(In first, In last, Out out, std::size_t memory_budget,
                   Compare cmp = Compare{}) {
    external_sorter<std::iter_value_t<In>, Compare> sorter(memory_budget,
                                                           std::move(cmp));
    sorter.push_range(first, last);
    sorter.drain(out);
}

} // namespace dlks_formal
