#pragma once

#include <bit>
#include <cstddef>
#include <cstdint>
#include <iterator>
#include <memory>
#include <stdexcept>
#include <utility>
#include <vector>

namespace packed {

// Minimal signed two's-complement width (in bits, 1..64) that can hold v.
inline int requiredWidth(int64_t v) {
    // v fits in w bits iff -(2^(w-1)) <= v <= 2^(w-1)-1.
    // For v >= 0: need v < 2^(w-1). For v < 0: need ~v < 2^(w-1).
    uint64_t u = v >= 0 ? static_cast<uint64_t>(v) : static_cast<uint64_t>(~v);
    if (u == 0) return 1;  // v is 0 or -1: fits in a single sign bit
    int magnitudeBits = 64 - std::countl_zero(u);
    return magnitudeBits + 1;  // +1 for the sign bit; u <= 2^63-1 so <= 64
}

// An immutable, bit-packed page of signed values using two's-complement
// truncation. A zero-length page is legal and has width 0.
class PackedPage {
public:
    PackedPage(const int64_t* values, size_t count) : size_(count) {
        int width = 0;
        for (size_t i = 0; i < count; ++i) {
            int w = requiredWidth(values[i]);
            if (w > width) width = w;
        }
        width_ = width;
        if (count == 0) return;
        words_.resize((count * static_cast<size_t>(width_) + 63) / 64, 0);
        for (size_t i = 0; i < count; ++i) put(i, static_cast<uint64_t>(values[i]));
    }

    explicit PackedPage(const std::vector<int64_t>& values)
        : PackedPage(values.data(), values.size()) {}

    int width() const { return width_; }
    size_t size() const { return size_; }

    int64_t get(size_t i) const {
        size_t bit = i * static_cast<size_t>(width_);
        size_t word = bit >> 6;
        size_t off = bit & 63;
        uint64_t raw;
        if (width_ == 64) {
            raw = words_[word];
        } else {
            uint64_t mask = (uint64_t{1} << width_) - 1;
            raw = words_[word] >> off;
            if (off + static_cast<size_t>(width_) > 64)
                raw |= words_[word + 1] << (64 - off);
            raw &= mask;
            // Sign-extend from bit width-1.
            if ((raw >> (width_ - 1)) & 1) raw |= ~uint64_t{0} << width_;
        }
        return static_cast<int64_t>(raw);
    }

private:
    void put(size_t i, uint64_t v) {
        size_t bit = i * static_cast<size_t>(width_);
        size_t word = bit >> 6;
        size_t off = bit & 63;
        if (width_ == 64) {
            words_[word] = v;
            return;
        }
        uint64_t mask = (uint64_t{1} << width_) - 1;
        words_[word] &= ~(mask << off);
        words_[word] |= (v & mask) << off;
        if (off + static_cast<size_t>(width_) > 64) {
            size_t hi = off + static_cast<size_t>(width_) - 64;
            uint64_t hiMask = (uint64_t{1} << hi) - 1;
            words_[word + 1] &= ~hiMask;
            words_[word + 1] |= (v >> (64 - off)) & hiMask;
        }
    }

    int width_ = 0;
    size_t size_ = 0;
    std::vector<uint64_t> words_;
};

// A column of signed 64-bit integers stored as a sequence of immutable
// packed pages. Point updates copy only the affected page (copy-on-write),
// recomputing its minimal width, so previously taken snapshots never change.
class IntColumn {
public:
    explicit IntColumn(size_t pageSize = 128) : pageSize_(pageSize) {
        if (pageSize == 0) throw std::invalid_argument("page size must be > 0");
    }

    static IntColumn fromValues(const std::vector<int64_t>& values, size_t pageSize = 128) {
        IntColumn col(pageSize);
        for (size_t begin = 0; begin < values.size(); begin += col.pageSize_) {
            size_t n = std::min(col.pageSize_, values.size() - begin);
            col.pages_.push_back({std::make_shared<const PackedPage>(values.data() + begin, n), begin});
        }
        col.size_ = values.size();
        return col;
    }

    // Builds a column with explicit page boundaries; zero-length pages are legal.
    static IntColumn fromPages(const std::vector<std::vector<int64_t>>& pages) {
        IntColumn col(1);
        size_t begin = 0;
        for (const auto& p : pages) {
            col.pages_.push_back({std::make_shared<const PackedPage>(p), begin});
            begin += p.size();
        }
        col.size_ = begin;
        return col;
    }

    size_t size() const { return size_; }
    size_t pageCount() const { return pages_.size(); }
    size_t pageSize() const { return pageSize_; }

    int pageWidth(size_t p) const { return pages_.at(p).page->width(); }
    size_t pageLength(size_t p) const { return pages_.at(p).page->size(); }

    int64_t get(size_t i) const {
        auto [page, off] = locate(i);
        return page->get(off);
    }

    void set(size_t i, int64_t v) {
        auto [pageIdx, off] = locateIndex(i);
        const PackedPage& old = *pages_[pageIdx].page;
        std::vector<int64_t> values;
        values.reserve(old.size());
        for (size_t k = 0; k < old.size(); ++k) values.push_back(old.get(k));
        values[off] = v;
        pages_[pageIdx].page = std::make_shared<const PackedPage>(values);
    }

    // Cheap snapshot: shares immutable pages; later updates copy-on-write.
    IntColumn snapshot() const { return *this; }

    class const_iterator {
    public:
        using iterator_category = std::forward_iterator_tag;
        using value_type = int64_t;
        using difference_type = std::ptrdiff_t;
        using pointer = void;
        using reference = int64_t;

        const_iterator() = default;
        const_iterator(const IntColumn* col, size_t page, size_t off)
            : col_(col), page_(page), off_(off) {}

        int64_t operator*() const { return col_->pages_[page_].page->get(off_); }

        const_iterator& operator++() {
            ++off_;
            while (page_ < col_->pages_.size() &&
                   off_ >= col_->pages_[page_].page->size()) {
                ++page_;
                off_ = 0;
            }
            return *this;
        }
        const_iterator operator++(int) {
            const_iterator tmp = *this;
            ++*this;
            return tmp;
        }
        friend bool operator==(const const_iterator& a, const const_iterator& b) {
            return a.page_ == b.page_ && a.off_ == b.off_;
        }

    private:
        const IntColumn* col_ = nullptr;
        size_t page_ = 0;
        size_t off_ = 0;
    };

    const_iterator begin() const {
        size_t p = 0;
        while (p < pages_.size() && pages_[p].page->size() == 0) ++p;
        return const_iterator(this, p, 0);
    }
    const_iterator end() const { return const_iterator(this, pages_.size(), 0); }

private:
    struct PageEntry {
        std::shared_ptr<const PackedPage> page;
        size_t begin;  // global index of the page's first element
    };

    std::pair<const PackedPage*, size_t> locate(size_t i) const {
        auto [idx, off] = locateIndex(i);
        return {pages_[idx].page.get(), off};
    }

    std::pair<size_t, size_t> locateIndex(size_t i) const {
        if (i >= size_) throw std::out_of_range("IntColumn index out of range");
        for (size_t p = 0; p < pages_.size(); ++p) {
            size_t n = pages_[p].page->size();
            if (i < pages_[p].begin + n) return {p, i - pages_[p].begin};
        }
        throw std::out_of_range("IntColumn index out of range");
    }

    std::vector<PageEntry> pages_;
    size_t pageSize_ = 128;
    size_t size_ = 0;
};

}  // namespace packed
