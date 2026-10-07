#pragma once

#include <cstddef>
#include <cstdint>
#include <iterator>
#include <memory>
#include <vector>

namespace intcol {

// Immutable bit-packed page of signed integers.
// Values are stored in two's complement truncated to `width` bits and
// sign-extended on read. A zero-length page has width 0 and no storage.
class Page {
public:
    Page() = default;  // zero-length page
    explicit Page(const std::vector<int64_t>& values);

    std::size_t size() const { return count_; }
    unsigned width() const { return width_; }
    int64_t get(std::size_t i) const;

    // Minimal number of two's-complement bits needed to hold v.
    static unsigned required_width(int64_t v);

private:
    void put(std::size_t i, int64_t v);

    uint8_t width_ = 0;
    uint32_t count_ = 0;
    std::vector<uint64_t> bits_;
};

// Column of signed 64-bit integers stored in fixed-capacity pages.
// Each page uses the minimal bit width sufficient for its current values.
// set() replaces the affected page copy-on-write, so snapshots taken with
// snapshot() (a shallow copy sharing immutable pages) never change.
class Column {
public:
    explicit Column(std::size_t page_capacity = 128);
    Column(const std::vector<int64_t>& values, std::size_t page_capacity = 128);
    // Builds a column from explicit per-page values; empty pages are legal.
    explicit Column(const std::vector<std::vector<int64_t>>& pages);

    std::size_t size() const { return size_; }
    std::size_t page_count() const { return pages_.size(); }
    std::size_t page_size(std::size_t p) const { return pages_.at(p)->size(); }
    unsigned page_width(std::size_t p) const { return pages_.at(p)->width(); }

    int64_t get(std::size_t index) const;
    void set(std::size_t index, int64_t value);

    // Cheap snapshot: shares immutable pages with this column.
    Column snapshot() const { return *this; }

    class iterator {
    public:
        using iterator_category = std::forward_iterator_tag;
        using value_type = int64_t;
        using difference_type = std::ptrdiff_t;

        iterator() = default;
        int64_t operator*() const { return col_->pages_[page_]->get(off_); }
        iterator& operator++() {
            advance();
            return *this;
        }
        iterator operator++(int) {
            iterator tmp = *this;
            advance();
            return tmp;
        }
        bool operator==(const iterator&) const = default;

    private:
        friend class Column;
        iterator(const Column* col, std::size_t page, std::size_t off)
            : col_(col), page_(page), off_(off) {}
        void advance();

        const Column* col_ = nullptr;
        std::size_t page_ = 0;
        std::size_t off_ = 0;
    };

    iterator begin() const;
    iterator end() const { return iterator(this, pages_.size(), 0); }

private:
    std::size_t locate(std::size_t index) const;  // page holding index

    std::vector<std::shared_ptr<const Page>> pages_;
    std::vector<std::size_t> offsets_;  // page start offsets, size = pages+1
    std::size_t size_ = 0;
};

}  // namespace intcol
