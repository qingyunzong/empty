#include "intcol/column.hpp"

#include <algorithm>
#include <bit>
#include <stdexcept>

namespace intcol {

unsigned Page::required_width(int64_t v) {
    // For v >= 0: bits of v plus a sign bit. For v < 0: bits of ~v plus a
    // sign bit (~v is the magnitude pattern of leading ones removed).
    uint64_t x = v < 0 ? ~static_cast<uint64_t>(v) : static_cast<uint64_t>(v);
    return static_cast<unsigned>(std::bit_width(x)) + 1;
}

Page::Page(const std::vector<int64_t>& values) : count_(values.size()) {
    unsigned w = 0;
    for (int64_t v : values) w = std::max(w, required_width(v));
    width_ = static_cast<uint8_t>(w);
    if (count_ == 0 || width_ == 0) return;
    bits_.assign((static_cast<std::size_t>(count_) * width_ + 63) / 64, 0);
    for (std::size_t i = 0; i < count_; ++i) put(i, values[i]);
}

void Page::put(std::size_t i, int64_t v) {
    uint64_t mask = width_ == 64 ? ~uint64_t{0} : ((uint64_t{1} << width_) - 1);
    uint64_t chunk = static_cast<uint64_t>(v) & mask;
    std::size_t bit = i * width_;
    std::size_t word = bit >> 6;
    unsigned off = static_cast<unsigned>(bit & 63);
    bits_[word] |= chunk << off;
    unsigned lo = 64 - off;
    if (width_ > lo) bits_[word + 1] |= chunk >> lo;
}

int64_t Page::get(std::size_t i) const {
    if (i >= count_) throw std::out_of_range("Page::get");
    uint64_t mask = width_ == 64 ? ~uint64_t{0} : ((uint64_t{1} << width_) - 1);
    std::size_t bit = i * width_;
    std::size_t word = bit >> 6;
    unsigned off = static_cast<unsigned>(bit & 63);
    uint64_t chunk;
    if (off + width_ <= 64) {
        chunk = (bits_[word] >> off) & mask;
    } else {
        unsigned lo = 64 - off;
        uint64_t hi_mask = (uint64_t{1} << (width_ - lo)) - 1;
        chunk = (bits_[word] >> off) | ((bits_[word + 1] & hi_mask) << lo);
    }
    // Sign-extend when the top stored bit is set.
    if (width_ < 64 && ((chunk >> (width_ - 1)) & 1)) chunk |= ~mask;
    return static_cast<int64_t>(chunk);
}

Column::Column(std::size_t page_capacity) : Column(std::vector<int64_t>{}, page_capacity) {}

Column::Column(const std::vector<int64_t>& values, std::size_t page_capacity) {
    if (page_capacity == 0) throw std::invalid_argument("page_capacity must be > 0");
    std::vector<std::vector<int64_t>> pages;
    for (std::size_t i = 0; i < values.size(); i += page_capacity)
        pages.emplace_back(values.begin() + i,
                           values.begin() + std::min(i + page_capacity, values.size()));
    *this = Column(pages);
}

Column::Column(const std::vector<std::vector<int64_t>>& pages) {
    offsets_.reserve(pages.size() + 1);
    offsets_.push_back(0);
    for (const auto& values : pages) {
        pages_.push_back(std::make_shared<const Page>(values));
        size_ += values.size();
        offsets_.push_back(size_);
    }
}

std::size_t Column::locate(std::size_t index) const {
    if (index >= size_) throw std::out_of_range("Column index");
    // First offset strictly greater than index; the page starts one before.
    auto it = std::upper_bound(offsets_.begin(), offsets_.end(), index);
    return static_cast<std::size_t>(it - offsets_.begin()) - 1;
}

int64_t Column::get(std::size_t index) const {
    std::size_t p = locate(index);
    return pages_[p]->get(index - offsets_[p]);
}

void Column::set(std::size_t index, int64_t value) {
    std::size_t p = locate(index);
    const Page& old = *pages_[p];
    std::vector<int64_t> values(old.size());
    for (std::size_t i = 0; i < values.size(); ++i) values[i] = old.get(i);
    values[index - offsets_[p]] = value;
    pages_[p] = std::make_shared<const Page>(values);  // copy-on-write
}

void Column::iterator::advance() {
    ++off_;
    while (page_ < col_->pages_.size()) {
        if (off_ < col_->pages_[page_]->size()) return;
        ++page_;
        off_ = 0;
    }
}

Column::iterator Column::begin() const {
    std::size_t p = 0;
    while (p < pages_.size() && pages_[p]->size() == 0) ++p;
    return iterator(this, p, 0);
}

}  // namespace intcol
