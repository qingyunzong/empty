#pragma once

#include <algorithm>
#include <concepts>
#include <cstddef>
#include <cstdint>
#include <iterator>
#include <limits>
#include <ranges>
#include <span>
#include <stdexcept>
#include <string>
#include <type_traits>
#include <utility>
#include <vector>

namespace dlks_formal {

/// An immutable-universe, run-length compressed bitmap.
///
/// Runs are stored as sorted, disjoint, non-adjacent half-open intervals
/// [begin, end). Every public operation restores this canonical form, so
/// consecutive compression/query/bitwise steps cannot change the represented
/// set.
class BitmapIndex {
public:
    using size_type = std::size_t;

    struct Run {
        size_type begin{};
        size_type end{};

        [[nodiscard]] constexpr size_type length() const noexcept {
            return end - begin;
        }

        friend constexpr bool operator==(const Run&, const Run&) = default;
    };

    BitmapIndex() noexcept = default;

    explicit BitmapIndex(size_type universe_size) noexcept
        : universe_size_(universe_size) {}

    explicit BitmapIndex(std::span<const bool> bits) {
        assign_bits(bits);
    }

    explicit BitmapIndex(const std::vector<bool>& bits) {
        assign_bits(bits);
    }

    template <typename BitRange>
        requires std::ranges::input_range<BitRange> &&
                 std::convertible_to<
                     std::ranges::range_reference_t<BitRange>, bool>
    explicit BitmapIndex(BitRange&& bits) {
        assign_bits(bits);
    }

    explicit BitmapIndex(std::span<const Run> runs, size_type universe_size)
        : universe_size_(universe_size), runs_(runs.begin(), runs.end()) {
        normalize_runs();
    }

    [[nodiscard]] static BitmapIndex from_bits(std::span<const bool> bits) {
        BitmapIndex result;
        result.assign_bits(bits);
        return result;
    }

    [[nodiscard]] static BitmapIndex from_bits(const std::vector<bool>& bits) {
        BitmapIndex result;
        result.assign_bits(bits);
        return result;
    }

    template <typename BitRange>
        requires std::ranges::input_range<BitRange> &&
                 std::convertible_to<
                     std::ranges::range_reference_t<BitRange>, bool>
    [[nodiscard]] static BitmapIndex from_bits(BitRange&& bits) {
        BitmapIndex result;
        result.assign_bits(bits);
        return result;
    }

    template <typename IndexRange>
        requires std::ranges::input_range<IndexRange> &&
                 std::integral<std::ranges::range_value_t<IndexRange>>
    [[nodiscard]] static BitmapIndex from_indices(
        IndexRange&& indices, size_type universe_size) {
        std::vector<size_type> positions;
        if constexpr (std::ranges::sized_range<IndexRange>) {
            positions.reserve(std::ranges::size(indices));
        }
        for (const auto index : indices) {
            const size_type position = checked_index(index);
            if (position >= universe_size) {
                throw std::out_of_range(
                    "BitmapIndex::from_indices: index outside universe");
            }
            positions.push_back(position);
        }
        return from_positions(std::move(positions), universe_size);
    }

    template <typename IndexRange>
        requires std::ranges::input_range<IndexRange> &&
                 std::integral<std::ranges::range_value_t<IndexRange>>
    [[nodiscard]] static BitmapIndex from_indices(
        IndexRange&& indices) {
        std::vector<size_type> positions;
        if constexpr (std::ranges::sized_range<IndexRange>) {
            positions.reserve(std::ranges::size(indices));
        }
        size_type universe_size = 0;
        for (const auto index : indices) {
            const size_type position = checked_index(index);
            if (position == std::numeric_limits<size_type>::max()) {
                throw std::length_error(
                    "BitmapIndex::from_indices: universe size overflow");
            }
            positions.push_back(position);
            universe_size = std::max(universe_size, position + 1);
        }
        return from_positions(std::move(positions), universe_size);
    }

    [[nodiscard]] static BitmapIndex from_runs(
        std::span<const Run> runs, size_type universe_size) {
        return BitmapIndex(runs, universe_size);
    }

    [[nodiscard]] static BitmapIndex full(size_type universe_size) {
        BitmapIndex result(universe_size);
        if (universe_size != 0) {
            result.runs_.push_back({0, universe_size});
        }
        return result;
    }

    [[nodiscard]] size_type universe_size() const noexcept {
        return universe_size_;
    }

    [[nodiscard]] size_type size() const noexcept {
        return universe_size_;
    }

    [[nodiscard]] bool empty() const noexcept {
        return runs_.empty();
    }

    [[nodiscard]] bool none() const noexcept {
        return empty();
    }

    [[nodiscard]] bool all() const noexcept {
        return universe_size_ == 0 ||
               (runs_.size() == 1 && runs_.front().begin == 0 &&
                runs_.front().end == universe_size_);
    }

    [[nodiscard]] size_type count() const noexcept {
        size_type total = 0;
        for (const Run& run : runs_) {
            total += run.length();
        }
        return total;
    }

    [[nodiscard]] size_type cardinality() const noexcept {
        return count();
    }

    [[nodiscard]] size_type run_count() const noexcept {
        return runs_.size();
    }

    [[nodiscard]] const std::vector<Run>& runs() const noexcept {
        return runs_;
    }

    [[nodiscard]] bool is_canonical() const noexcept {
        size_type previous_end = 0;
        bool first = true;
        for (const Run& run : runs_) {
            if (run.begin >= run.end || run.end > universe_size_) {
                return false;
            }
            if (!first && run.begin <= previous_end) {
                return false;
            }
            previous_end = run.end;
            first = false;
        }
        return true;
    }

    [[nodiscard]] bool test(size_type position) const {
        if (position >= universe_size_) {
            throw std::out_of_range(
                "BitmapIndex::test: position outside universe");
        }
        return test_unchecked(position);
    }

    [[nodiscard]] bool contains(size_type position) const noexcept {
        return position < universe_size_ && test_unchecked(position);
    }

    [[nodiscard]] bool operator[](size_type position) const noexcept {
        return contains(position);
    }

    void set() {
        runs_.clear();
        if (universe_size_ != 0) {
            runs_.push_back({0, universe_size_});
        }
    }

    void set(size_type position) {
        check_position(position);
        set_range(position, position + 1);
    }

    void set(size_type first, size_type last) {
        set_range(first, last);
    }

    void set_range(size_type first, size_type last, bool value = true) {
        check_range(first, last);
        if (first == last) {
            return;
        }
        erase_range(first, last);
        if (value) {
            insert_range(first, last);
        }
    }

    void reset() noexcept {
        runs_.clear();
    }

    void reset(size_type position) {
        check_position(position);
        erase_range(position, position + 1);
    }

    void reset_range(size_type first, size_type last) {
        check_range(first, last);
        erase_range(first, last);
    }

    void flip() {
        runs_ = complement_runs();
    }

    void flip(size_type position) {
        check_position(position);
        flip_range(position, position + 1);
    }

    void flip_range(size_type first, size_type last) {
        check_range(first, last);
        if (first == last) {
            return;
        }
        BitmapIndex mask(universe_size_);
        mask.insert_range(first, last);
        *this = *this ^ mask;
    }

    void resize(size_type new_universe_size) {
        if (new_universe_size < universe_size_) {
            std::vector<Run> clipped;
            clipped.reserve(runs_.size());
            for (const Run& run : runs_) {
                if (run.begin >= new_universe_size) {
                    break;
                }
                append_run(clipped, run.begin,
                           std::min(run.end, new_universe_size));
            }
            runs_ = std::move(clipped);
        }
        universe_size_ = new_universe_size;
    }

    void clear() noexcept {
        runs_.clear();
    }

    [[nodiscard]] std::vector<bool> to_bits() const {
        std::vector<bool> bits(universe_size_, false);
        for (const Run& run : runs_) {
            std::fill(
                bits.begin() + static_cast<std::ptrdiff_t>(run.begin),
                bits.begin() + static_cast<std::ptrdiff_t>(run.end), true);
        }
        return bits;
    }

    [[nodiscard]] std::vector<size_type> to_indices() const {
        std::vector<size_type> indices;
        indices.reserve(count());
        for (const Run& run : runs_) {
            for (size_type position = run.begin; position < run.end;
                 ++position) {
                indices.push_back(position);
            }
        }
        return indices;
    }

    [[nodiscard]] BitmapIndex operator&(const BitmapIndex& other) const {
        require_same_universe(other, "AND");
        BitmapIndex result(universe_size_);
        result.runs_.reserve(runs_.size() + other.runs_.size());

        size_type left = 0;
        size_type right = 0;
        while (left < runs_.size() && right < other.runs_.size()) {
            const Run& lhs = runs_[left];
            const Run& rhs = other.runs_[right];
            const size_type begin = std::max(lhs.begin, rhs.begin);
            const size_type end = std::min(lhs.end, rhs.end);
            if (begin < end) {
                append_run(result.runs_, begin, end);
            }
            if (lhs.end <= rhs.end) {
                ++left;
            }
            if (rhs.end <= lhs.end) {
                ++right;
            }
        }
        return result;
    }

    [[nodiscard]] BitmapIndex operator|(const BitmapIndex& other) const {
        require_same_universe(other, "OR");
        BitmapIndex result(universe_size_);
        result.runs_.reserve(runs_.size() + other.runs_.size());

        size_type left = 0;
        size_type right = 0;
        while (left < runs_.size() || right < other.runs_.size()) {
            if (right == other.runs_.size() ||
                (left < runs_.size() &&
                 runs_[left].begin <= other.runs_[right].begin)) {
                append_run(result.runs_, runs_[left].begin,
                           runs_[left].end);
                ++left;
            } else {
                append_run(result.runs_, other.runs_[right].begin,
                           other.runs_[right].end);
                ++right;
            }
        }
        return result;
    }

    [[nodiscard]] BitmapIndex operator-(const BitmapIndex& other) const {
        require_same_universe(other, "AND-NOT");
        BitmapIndex result(universe_size_);
        result.runs_.reserve(runs_.size());

        size_type right = 0;
        for (const Run& lhs : runs_) {
            while (right < other.runs_.size() &&
                   other.runs_[right].end <= lhs.begin) {
                ++right;
            }

            size_type cursor = lhs.begin;
            for (size_type index = right;
                 index < other.runs_.size() &&
                 other.runs_[index].begin < lhs.end;
                 ++index) {
                const Run& rhs = other.runs_[index];
                if (rhs.end <= cursor) {
                    continue;
                }
                if (cursor < rhs.begin) {
                    append_run(result.runs_, cursor,
                               std::min(rhs.begin, lhs.end));
                }
                cursor = std::max(cursor, rhs.end);
                if (cursor >= lhs.end) {
                    break;
                }
            }
            if (cursor < lhs.end) {
                append_run(result.runs_, cursor, lhs.end);
            }
        }
        return result;
    }

    [[nodiscard]] BitmapIndex operator^(const BitmapIndex& other) const {
        require_same_universe(other, "XOR");
        BitmapIndex left_difference = *this - other;
        BitmapIndex right_difference = other - *this;
        return std::move(left_difference) | right_difference;
    }

    [[nodiscard]] BitmapIndex operator~() const {
        BitmapIndex result(universe_size_);
        result.runs_ = complement_runs();
        return result;
    }

    BitmapIndex& operator&=(const BitmapIndex& other) {
        *this = *this & other;
        return *this;
    }

    BitmapIndex& operator|=(const BitmapIndex& other) {
        *this = *this | other;
        return *this;
    }

    BitmapIndex& operator-=(const BitmapIndex& other) {
        *this = *this - other;
        return *this;
    }

    BitmapIndex& operator^=(const BitmapIndex& other) {
        *this = *this ^ other;
        return *this;
    }

    BitmapIndex& and_with(const BitmapIndex& other) {
        return *this &= other;
    }

    BitmapIndex& or_with(const BitmapIndex& other) {
        return *this |= other;
    }

    BitmapIndex& and_not_with(const BitmapIndex& other) {
        return *this -= other;
    }

    [[nodiscard]] BitmapIndex intersection(const BitmapIndex& other) const {
        return *this & other;
    }

    [[nodiscard]] BitmapIndex set_union(const BitmapIndex& other) const {
        return *this | other;
    }

    [[nodiscard]] BitmapIndex difference(const BitmapIndex& other) const {
        return *this - other;
    }

    [[nodiscard]] BitmapIndex complement() const {
        return ~*this;
    }

    void swap(BitmapIndex& other) noexcept {
        std::swap(universe_size_, other.universe_size_);
        runs_.swap(other.runs_);
    }

    friend bool operator==(const BitmapIndex& left,
                           const BitmapIndex& right) noexcept {
        return left.universe_size_ == right.universe_size_ &&
               left.runs_ == right.runs_;
    }

private:
    template <typename Bits>
    void assign_bits(const Bits& bits) {
        universe_size_ = 0;
        runs_.clear();

        size_type run_begin = 0;
        bool inside_run = false;
        for (const auto& raw_bit : bits) {
            const bool bit = static_cast<bool>(raw_bit);
            if (bit && !inside_run) {
                run_begin = universe_size_;
                inside_run = true;
            } else if (!bit && inside_run) {
                append_run(runs_, run_begin, universe_size_);
                inside_run = false;
            }
            ++universe_size_;
        }
        if (inside_run) {
            append_run(runs_, run_begin, universe_size_);
        }
    }

    template <std::integral Index>
    [[nodiscard]] static size_type checked_index(Index index) {
        if constexpr (std::is_signed_v<Index>) {
            if (index < 0) {
                throw std::out_of_range(
                    "BitmapIndex::from_indices: negative index");
            }
        }
        return static_cast<size_type>(index);
    }

    [[nodiscard]] static BitmapIndex from_positions(
        std::vector<size_type> positions, size_type universe_size) {
        BitmapIndex result(universe_size);
        std::sort(positions.begin(), positions.end());
        positions.erase(
            std::unique(positions.begin(), positions.end()), positions.end());
        result.runs_.reserve(positions.size());
        for (const size_type position : positions) {
            append_run(result.runs_, position, position + 1);
        }
        return result;
    }

    [[nodiscard]] bool test_unchecked(size_type position) const noexcept {
        const auto it = std::upper_bound(
            runs_.begin(), runs_.end(), position,
            [](size_type value, const Run& run) {
                return value < run.begin;
            });
        if (it == runs_.begin()) {
            return false;
        }
        return position < std::prev(it)->end;
    }

    void check_position(size_type position) const {
        if (position >= universe_size_) {
            throw std::out_of_range(
                "BitmapIndex: position outside universe");
        }
    }

    void check_range(size_type first, size_type last) const {
        if (first > last) {
            throw std::invalid_argument(
                "BitmapIndex: range begin is after range end");
        }
        if (last > universe_size_) {
            throw std::out_of_range(
                "BitmapIndex: range outside universe");
        }
    }

    void require_same_universe(const BitmapIndex& other,
                               const char* operation) const {
        if (universe_size_ != other.universe_size_) {
            throw std::invalid_argument(std::string("BitmapIndex::") +
                                        operation +
                                        ": universe sizes differ");
        }
    }

    void normalize_runs() {
        for (const Run& run : runs_) {
            if (run.begin > run.end) {
                throw std::invalid_argument(
                    "BitmapIndex: run begin is after run end");
            }
        }

        std::sort(runs_.begin(), runs_.end(),
                  [](const Run& left, const Run& right) {
                      if (left.begin != right.begin) {
                          return left.begin < right.begin;
                      }
                      return left.end < right.end;
                  });

        std::vector<Run> normalized;
        normalized.reserve(runs_.size());
        for (const Run& run : runs_) {
            if (run.begin >= universe_size_) {
                continue;
            }
            append_run(normalized, run.begin,
                       std::min(run.end, universe_size_));
        }
        runs_ = std::move(normalized);
    }

    void erase_range(size_type first, size_type last) {
        if (first == last || runs_.empty()) {
            return;
        }

        std::vector<Run> erased;
        erased.reserve(runs_.size() + 1);
        for (const Run& run : runs_) {
            if (run.end <= first || run.begin >= last) {
                erased.push_back(run);
                continue;
            }
            if (run.begin < first) {
                append_run(erased, run.begin, first);
            }
            if (run.end > last) {
                append_run(erased, last, run.end);
            }
        }
        runs_ = std::move(erased);
    }

    void insert_range(size_type first, size_type last) {
        if (first == last) {
            return;
        }

        std::vector<Run> merged;
        merged.reserve(runs_.size() + 1);
        size_type merged_begin = first;
        size_type merged_end = last;
        bool inserted = false;

        for (const Run& run : runs_) {
            if (!inserted && run.begin > merged_end) {
                append_run(merged, merged_begin, merged_end);
                inserted = true;
            }

            if (run.end < merged_begin) {
                merged.push_back(run);
            } else if (run.begin > merged_end) {
                merged.push_back(run);
            } else {
                merged_begin = std::min(merged_begin, run.begin);
                merged_end = std::max(merged_end, run.end);
            }
        }

        if (!inserted) {
            append_run(merged, merged_begin, merged_end);
        }
        runs_ = std::move(merged);
    }

    [[nodiscard]] std::vector<Run> complement_runs() const {
        std::vector<Run> result;
        result.reserve(runs_.size() + 1);

        size_type cursor = 0;
        for (const Run& run : runs_) {
            if (cursor < run.begin) {
                append_run(result, cursor, run.begin);
            }
            cursor = run.end;
        }
        if (cursor < universe_size_) {
            append_run(result, cursor, universe_size_);
        }
        return result;
    }

    static void append_run(std::vector<Run>& output, size_type begin,
                           size_type end) {
        if (begin >= end) {
            return;
        }
        if (!output.empty() && begin <= output.back().end) {
            output.back().end = std::max(output.back().end, end);
        } else {
            output.push_back({begin, end});
        }
    }

    size_type universe_size_{0};
    std::vector<Run> runs_;
};

[[nodiscard]] inline BitmapIndex bitmap_and(const BitmapIndex& left,
                                            const BitmapIndex& right) {
    return left & right;
}

[[nodiscard]] inline BitmapIndex bitmap_or(const BitmapIndex& left,
                                           const BitmapIndex& right) {
    return left | right;
}

[[nodiscard]] inline BitmapIndex bitmap_not(const BitmapIndex& bitmap) {
    return ~bitmap;
}

[[nodiscard]] inline BitmapIndex bitmap_and_not(const BitmapIndex& left,
                                                const BitmapIndex& right) {
    return left - right;
}

[[nodiscard]] inline BitmapIndex bitmap_xor(const BitmapIndex& left,
                                            const BitmapIndex& right) {
    return left ^ right;
}

[[nodiscard]] inline std::size_t cardinality(
    const BitmapIndex& bitmap) noexcept {
    return bitmap.count();
}

using RunBitmap = BitmapIndex;
using RunLengthBitmap = BitmapIndex;
using CompressedBitmap = BitmapIndex;

}  // namespace dlks_formal
