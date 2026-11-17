#pragma once

#include <algorithm>
#include <array>
#include <bit>
#include <concepts>
#include <cstddef>
#include <cstdint>
#include <exception>
#include <limits>
#include <optional>
#include <span>
#include <stdexcept>
#include <string>
#include <string_view>
#include <type_traits>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

namespace dlks_formal {

class CodecError : public std::runtime_error {
public:
    explicit CodecError(const std::string& message) : std::runtime_error(message) {}
};

class EncodingError : public CodecError {
public:
    explicit EncodingError(const std::string& message) : CodecError(message) {}
};

class PageFormatError : public CodecError {
public:
    explicit PageFormatError(const std::string& message) : CodecError(message) {}
};

enum class Encoding : std::uint8_t {
    Plain = 0,
    Dictionary = 1,
    Rle = 2,
    Delta = 3,
};

inline constexpr std::string_view encoding_name(Encoding encoding) noexcept {
    switch (encoding) {
    case Encoding::Plain:
        return "plain";
    case Encoding::Dictionary:
        return "dictionary";
    case Encoding::Rle:
        return "rle";
    case Encoding::Delta:
        return "delta";
    }
    return "unknown";
}

inline constexpr std::string_view to_string(Encoding encoding) noexcept {
    return encoding_name(encoding);
}

template <class T>
concept ColumnValue =
    std::integral<T> && std::same_as<T, std::remove_cv_t<T>> &&
    !std::same_as<T, bool> && (sizeof(T) <= 8);

// Bit 1 means NULL. Unused trailing bits are kept clear.
class NullBitmap {
public:
    NullBitmap() = default;

    explicit NullBitmap(std::size_t rows) {
        resize(rows, true);
    }

    static NullBitmap all_null(std::size_t rows) {
        NullBitmap bitmap(rows);
        bitmap.set_all_null();
        return bitmap;
    }

    std::size_t size() const noexcept {
        return rows_;
    }

    bool empty() const noexcept {
        return rows_ == 0;
    }

    std::size_t byte_size() const noexcept {
        return bytes_.size();
    }

    bool is_null(std::size_t row) const {
        if (row >= rows_) {
            throw std::out_of_range("NullBitmap::is_null row out of range");
        }
        return (bytes_[row >> 3] & static_cast<std::uint8_t>(1u << (row & 7u))) != 0;
    }

    bool is_valid(std::size_t row) const {
        return !is_null(row);
    }

    void set_null(std::size_t row, bool is_null_value = true) {
        if (row >= rows_) {
            throw std::out_of_range("NullBitmap::set_null row out of range");
        }
        const std::uint8_t mask = static_cast<std::uint8_t>(1u << (row & 7u));
        if (is_null_value) {
            bytes_[row >> 3] |= mask;
        } else {
            bytes_[row >> 3] &= static_cast<std::uint8_t>(~mask);
        }
    }

    void set_valid(std::size_t row, bool is_valid_value = true) {
        set_null(row, !is_valid_value);
    }

    void set_all_null() {
        std::fill(bytes_.begin(), bytes_.end(), std::uint8_t{0xff});
        clear_unused_bits();
    }

    void set_all_valid() {
        std::fill(bytes_.begin(), bytes_.end(), std::uint8_t{0});
    }

    void resize(std::size_t rows, bool new_rows_valid = true) {
        const std::size_t old_rows = rows_;
        const std::size_t new_bytes = rows / 8u + (rows % 8u != 0 ? 1u : 0u);
        bytes_.resize(new_bytes, std::uint8_t{0});

        if (rows > old_rows && !new_rows_valid) {
            for (std::size_t row = old_rows; row < rows; ++row) {
                bytes_[row >> 3] |= static_cast<std::uint8_t>(1u << (row & 7u));
            }
        }
        rows_ = rows;
        clear_unused_bits();
    }

    void clear() noexcept {
        rows_ = 0;
        bytes_.clear();
    }

    std::size_t null_count() const noexcept {
        std::size_t count = 0;
        for (std::size_t i = 0; i < bytes_.size(); ++i) {
            std::uint8_t value = bytes_[i];
            if (i + 1 == bytes_.size() && (rows_ & 7u) != 0) {
                value &= static_cast<std::uint8_t>((1u << (rows_ & 7u)) - 1u);
            }
            count += static_cast<std::size_t>(std::popcount(value));
        }
        return count;
    }

    bool any_null() const noexcept {
        return null_count() != 0;
    }

    std::span<const std::uint8_t> data() const noexcept {
        return std::span<const std::uint8_t>(bytes_.data(), bytes_.size());
    }

    std::span<std::uint8_t> data() noexcept {
        return std::span<std::uint8_t>(bytes_.data(), bytes_.size());
    }

private:
    void clear_unused_bits() noexcept {
        if (!bytes_.empty() && (rows_ & 7u) != 0) {
            bytes_.back() &= static_cast<std::uint8_t>((1u << (rows_ & 7u)) - 1u);
        }
    }

    std::size_t rows_ = 0;
    std::vector<std::uint8_t> bytes_;
};

template <ColumnValue T>
class ColumnView;

template <ColumnValue T>
struct Column {
    std::vector<T> values;
    NullBitmap nulls;

    Column() = default;

    explicit Column(std::size_t rows) : values(rows), nulls(rows) {}

    std::size_t size() const noexcept {
        return values.size();
    }

    bool empty() const noexcept {
        return values.empty();
    }

    bool is_null(std::size_t row) const {
        if (row >= values.size()) {
            throw std::out_of_range("Column::is_null row out of range");
        }
        if (nulls.empty()) {
            return false;
        }
        if (nulls.size() != values.size()) {
            throw std::logic_error("Column null bitmap size does not match values");
        }
        return nulls.is_null(row);
    }

    ColumnView<T> view() const;
};

template <ColumnValue T>
class ColumnView {
public:
    ColumnView() = default;

    explicit ColumnView(std::span<const T> values) : values_(values) {}

    ColumnView(std::span<const T> values, std::span<const std::uint8_t> null_bitmap)
        : values_(values), null_bitmap_(null_bitmap) {
        validate_bitmap();
    }

    explicit ColumnView(const Column<T>& column) {
        if (!column.nulls.empty() && column.nulls.size() != column.values.size()) {
            throw std::invalid_argument("Column null bitmap size does not match values");
        }
        values_ = std::span<const T>(column.values.data(), column.values.size());
        null_bitmap_ = column.nulls.data();
    }

    std::size_t size() const noexcept {
        return values_.size();
    }

    bool empty() const noexcept {
        return values_.empty();
    }

    std::span<const T> values() const noexcept {
        return values_;
    }

    std::span<const std::uint8_t> null_bitmap() const noexcept {
        return null_bitmap_;
    }

    bool has_null_bitmap() const noexcept {
        return !null_bitmap_.empty();
    }

    bool is_null(std::size_t row) const {
        if (row >= values_.size()) {
            throw std::out_of_range("ColumnView::is_null row out of range");
        }
        if (null_bitmap_.empty()) {
            return false;
        }
        return (null_bitmap_[row >> 3] & static_cast<std::uint8_t>(1u << (row & 7u))) != 0;
    }

    bool has_nulls() const noexcept {
        if (null_bitmap_.empty()) {
            return false;
        }
        for (std::size_t row = 0; row < values_.size(); ++row) {
            if ((null_bitmap_[row >> 3] & static_cast<std::uint8_t>(1u << (row & 7u))) != 0) {
                return true;
            }
        }
        return false;
    }

private:
    void validate_bitmap() const {
        const std::size_t required =
            values_.size() / 8u + (values_.size() % 8u != 0 ? 1u : 0u);
        if (!null_bitmap_.empty() && null_bitmap_.size() < required) {
            throw std::invalid_argument("null bitmap is shorter than the column");
        }
    }

    std::span<const T> values_;
    std::span<const std::uint8_t> null_bitmap_;
};

template <ColumnValue T>
ColumnView<T> Column<T>::view() const {
    return ColumnView<T>(*this);
}

struct EncodeOptions {
    std::optional<Encoding> force_encoding;
    std::uint64_t max_encoded_bytes = std::numeric_limits<std::uint64_t>::max();
    std::uint64_t max_dictionary_entries = std::numeric_limits<std::uint64_t>::max();
    std::uint64_t max_rle_runs = std::numeric_limits<std::uint64_t>::max();
};

struct EncodingEstimate {
    Encoding encoding = Encoding::Plain;
    std::uint64_t total_bytes = 0;
    std::uint64_t header_bytes = 0;
    std::uint64_t null_bitmap_bytes = 0;
    std::uint64_t metadata_bytes = 0;
    std::uint64_t value_bytes = 0;
    std::uint64_t alignment_bytes = 0;
    std::uint64_t entry_count = 0;
    std::uint8_t value_width = 0;
    std::uint8_t value_bits = 0;
    std::uint8_t length_bits = 0;
    std::uint8_t block_size = 0;
};

namespace detail {

inline constexpr std::uint32_t kMagic = 0x534b4c44u; // "DLKS".
inline constexpr std::uint16_t kVersion = 1;
inline constexpr std::uint64_t kHeaderBytes = 64;
inline constexpr std::uint8_t kDeltaBlockSize = 32;

inline std::uint64_t checked_add(std::uint64_t lhs, std::uint64_t rhs) {
    if (lhs > std::numeric_limits<std::uint64_t>::max() - rhs) {
        throw EncodingError("encoded page size overflow");
    }
    return lhs + rhs;
}

inline std::uint64_t checked_mul(std::uint64_t lhs, std::uint64_t rhs) {
    if (lhs != 0 && rhs > std::numeric_limits<std::uint64_t>::max() / lhs) {
        throw EncodingError("encoded page size overflow");
    }
    return lhs * rhs;
}

inline std::uint64_t align_up(std::uint64_t value, std::uint64_t alignment = 8) {
    const std::uint64_t with_padding = checked_add(value, alignment - 1);
    return (with_padding / alignment) * alignment;
}

inline std::uint64_t bitmap_byte_count(std::uint64_t rows) {
    return checked_add(rows, 7) / 8;
}

inline unsigned bits_required(std::uint64_t value) noexcept {
    return value == 0 ? 0u : 64u - static_cast<unsigned>(std::countl_zero(value));
}

template <class U>
U load_le(std::span<const std::byte> bytes, std::uint64_t offset) {
    using Unsigned = std::make_unsigned_t<U>;
    if (offset > bytes.size() || sizeof(Unsigned) > bytes.size() - static_cast<std::size_t>(offset)) {
        throw PageFormatError("truncated page field");
    }
    Unsigned result = 0;
    for (std::size_t i = 0; i < sizeof(Unsigned); ++i) {
        const auto value = std::to_integer<Unsigned>(bytes[static_cast<std::size_t>(offset) + i]);
        result |= static_cast<Unsigned>(value << (8u * i));
    }
    return result;
}

template <class U>
void store_le(std::span<std::byte> bytes, std::uint64_t offset, U value) {
    using Unsigned = std::make_unsigned_t<U>;
    if (offset > bytes.size() || sizeof(Unsigned) > bytes.size() - static_cast<std::size_t>(offset)) {
        throw EncodingError("page write out of bounds");
    }
    const Unsigned source = static_cast<Unsigned>(value);
    for (std::size_t i = 0; i < sizeof(Unsigned); ++i) {
        bytes[static_cast<std::size_t>(offset) + i] =
            std::byte{static_cast<unsigned char>((source >> (8u * i)) & Unsigned{0xff})};
    }
}

template <ColumnValue T>
void store_value(std::span<std::byte> bytes, std::uint64_t offset, T value) {
    using U = std::make_unsigned_t<T>;
    store_le<U>(bytes, offset, std::bit_cast<U>(value));
}

template <ColumnValue T>
T load_value(std::span<const std::byte> bytes, std::uint64_t offset) {
    using U = std::make_unsigned_t<T>;
    return std::bit_cast<T>(load_le<U>(bytes, offset));
}

template <class U>
U zigzag_encode(U raw) noexcept {
    constexpr unsigned width = static_cast<unsigned>(sizeof(U) * 8);
    const U sign = static_cast<U>(raw >> (width - 1));
    return static_cast<U>(static_cast<U>(raw << 1) ^ static_cast<U>(U{0} - sign));
}

template <class U>
U zigzag_decode(std::uint64_t encoded) noexcept {
    const std::uint64_t raw = (encoded >> 1) ^ (std::uint64_t{0} - (encoded & 1u));
    return static_cast<U>(raw);
}

class BitReader {
public:
    BitReader(std::span<const std::byte> data, std::uint64_t bit_offset)
        : data_(data), bit_position_(bit_offset) {
        if (bit_offset > static_cast<std::uint64_t>(data.size()) * 8u) {
            throw PageFormatError("bit offset is outside the page");
        }
    }

    std::uint64_t read(unsigned count) {
        if (count > 64) {
            throw PageFormatError("bit read wider than 64 bits");
        }
        if (count > remaining_bits()) {
            throw PageFormatError("truncated packed values");
        }

        std::uint64_t result = 0;
        unsigned done = 0;
        while (done < count) {
            const std::uint64_t position = bit_position_ + done;
            const auto index = static_cast<std::size_t>(position >> 3);
            const unsigned bit_offset = static_cast<unsigned>(position & 7u);
            const unsigned take = std::min<unsigned>(count - done, 8u - bit_offset);
            const std::uint64_t mask = (std::uint64_t{1} << take) - 1u;
            const auto byte = std::to_integer<std::uint8_t>(data_[index]);
            result |= ((static_cast<std::uint64_t>(byte) >> bit_offset) & mask) << done;
            done += take;
        }
        bit_position_ += count;
        return result;
    }

    std::uint64_t remaining_bits() const noexcept {
        return static_cast<std::uint64_t>(data_.size()) * 8u - bit_position_;
    }

private:
    std::span<const std::byte> data_;
    std::uint64_t bit_position_ = 0;
};

class BitWriter {
public:
    BitWriter(std::span<std::byte> data, std::uint64_t bit_offset)
        : data_(data), bit_position_(bit_offset) {
        if (bit_offset > static_cast<std::uint64_t>(data.size()) * 8u) {
            throw EncodingError("bit offset is outside the page");
        }
    }

    void write(std::uint64_t value, unsigned count) {
        if (count > 64) {
            throw EncodingError("bit write wider than 64 bits");
        }
        if (count > remaining_bits()) {
            throw EncodingError("packed values exceed the page");
        }

        unsigned done = 0;
        while (done < count) {
            const std::uint64_t position = bit_position_ + done;
            const auto index = static_cast<std::size_t>(position >> 3);
            const unsigned bit_offset = static_cast<unsigned>(position & 7u);
            const unsigned take = std::min<unsigned>(count - done, 8u - bit_offset);
            const std::uint64_t mask = (std::uint64_t{1} << take) - 1u;
            const unsigned shifted_mask = static_cast<unsigned>(mask << bit_offset);
            unsigned byte = std::to_integer<unsigned>(data_[index]);
            byte = (byte & ~shifted_mask) |
                   (static_cast<unsigned>(((value >> done) & mask) << bit_offset));
            data_[index] = std::byte{static_cast<unsigned char>(byte)};
            done += take;
        }
        bit_position_ += count;
    }

    std::uint64_t remaining_bits() const noexcept {
        return static_cast<std::uint64_t>(data_.size()) * 8u - bit_position_;
    }

private:
    std::span<std::byte> data_;
    std::uint64_t bit_position_ = 0;
};

struct Analysis {
    std::uint64_t rows = 0;
    bool has_nulls = false;
    std::uint64_t unique_count = 0;
    std::uint64_t run_count = 0;
    std::uint64_t max_run_length = 0;
    std::uint8_t delta_bits = 0;
};

template <ColumnValue T>
Analysis analyze(const ColumnView<T>& view) {
    Analysis result;
    result.rows = view.size();
    result.has_nulls = view.has_nulls();
    if (result.rows == 0) {
        return result;
    }

    using U = std::make_unsigned_t<T>;
    std::unordered_set<T> unique;
    unique.reserve(static_cast<std::size_t>(
        std::min<std::uint64_t>(result.rows, 65536u)));
    unique.insert(view.values()[0]);

    result.run_count = 1;
    std::uint64_t current_run_length = 1;
    std::uint64_t max_zigzag = 0;
    U previous = std::bit_cast<U>(view.values()[0]);

    for (std::size_t i = 1; i < view.values().size(); ++i) {
        const T value = view.values()[i];
        unique.insert(value);

        if (value != view.values()[i - 1]) {
            ++result.run_count;
            result.max_run_length = std::max(result.max_run_length, current_run_length);
            current_run_length = 1;
        } else {
            ++current_run_length;
        }

        const U current = std::bit_cast<U>(value);
        const U difference = static_cast<U>(current - previous);
        max_zigzag = std::max(max_zigzag, static_cast<std::uint64_t>(zigzag_encode(difference)));
        previous = current;
    }
    result.max_run_length = std::max(result.max_run_length, current_run_length);
    result.unique_count = unique.size();
    result.delta_bits = static_cast<std::uint8_t>(bits_required(max_zigzag));
    return result;
}

struct PageLayout {
    Encoding encoding = Encoding::Plain;
    std::uint64_t rows = 0;
    std::uint64_t total_bytes = 0;
    std::uint64_t bitmap_offset = 0;
    std::uint64_t bitmap_bytes = 0;
    std::uint64_t payload_offset = 0;
    std::uint64_t aux_offset = 0;
    std::uint64_t metadata_bytes = 0;
    std::uint64_t value_bytes = 0;
    std::uint64_t alignment_bytes = 0;
    std::uint64_t entry_count = 0;
    std::uint8_t value_width = 0;
    std::uint8_t value_bits = 0;
    std::uint8_t length_bits = 0;
    std::uint8_t block_size = 0;
};

inline PageLayout make_layout(Encoding encoding, const Analysis& analysis,
                              std::uint8_t value_width) {
    PageLayout layout;
    layout.encoding = encoding;
    layout.rows = analysis.rows;
    layout.value_width = value_width;
    layout.bitmap_offset = analysis.has_nulls ? kHeaderBytes : 0;
    layout.bitmap_bytes = analysis.has_nulls ? bitmap_byte_count(analysis.rows) : 0;

    const std::uint64_t bitmap_end = checked_add(kHeaderBytes, layout.bitmap_bytes);
    layout.payload_offset = align_up(bitmap_end, 8);

    switch (encoding) {
    case Encoding::Plain: {
        layout.entry_count = analysis.rows;
        layout.metadata_bytes = 0;
        layout.value_bytes = checked_mul(analysis.rows, value_width);
        layout.aux_offset = 0;
        layout.value_bits = static_cast<std::uint8_t>(value_width * 8u);
        break;
    }
    case Encoding::Dictionary: {
        const unsigned index_bits =
            analysis.unique_count > 1 ? bits_required(analysis.unique_count - 1) : 0;
        layout.entry_count = analysis.unique_count;
        layout.metadata_bytes = checked_mul(analysis.unique_count, value_width);
        layout.value_bytes =
            checked_add(checked_mul(analysis.rows, index_bits), 7) / 8;
        layout.aux_offset = checked_add(layout.payload_offset, layout.metadata_bytes);
        layout.value_bits = static_cast<std::uint8_t>(index_bits);
        break;
    }
    case Encoding::Rle: {
        const unsigned length_bits =
            analysis.max_run_length == 0 ? 0 : bits_required(analysis.max_run_length);
        layout.entry_count = analysis.run_count;
        layout.metadata_bytes = checked_mul(analysis.run_count, value_width);
        layout.value_bytes =
            checked_add(checked_mul(analysis.run_count, length_bits), 7) / 8;
        layout.aux_offset = checked_add(layout.payload_offset, layout.metadata_bytes);
        layout.value_bits = static_cast<std::uint8_t>(value_width * 8u);
        layout.length_bits = static_cast<std::uint8_t>(length_bits);
        break;
    }
    case Encoding::Delta: {
        const std::uint64_t checkpoints =
            analysis.rows == 0 ? 0 : ((analysis.rows - 1) / kDeltaBlockSize) + 1;
        const std::uint64_t delta_count = analysis.rows == 0 ? 0 : analysis.rows - 1;
        layout.entry_count = checkpoints;
        layout.metadata_bytes = checked_mul(checkpoints, value_width);
        layout.value_bytes =
            checked_add(checked_mul(delta_count, analysis.delta_bits), 7) / 8;
        layout.aux_offset = checked_add(layout.payload_offset, layout.metadata_bytes);
        layout.value_bits = analysis.delta_bits;
        layout.block_size = kDeltaBlockSize;
        break;
    }
    }

    const std::uint64_t content_end =
        checked_add(layout.payload_offset,
                    checked_add(layout.metadata_bytes, layout.value_bytes));
    layout.total_bytes = align_up(content_end, 8);
    layout.alignment_bytes =
        checked_add(layout.payload_offset - bitmap_end, layout.total_bytes - content_end);
    return layout;
}

inline EncodingEstimate estimate_from_layout(const PageLayout& layout) {
    EncodingEstimate estimate;
    estimate.encoding = layout.encoding;
    estimate.total_bytes = layout.total_bytes;
    estimate.header_bytes = kHeaderBytes;
    estimate.null_bitmap_bytes = layout.bitmap_bytes;
    estimate.metadata_bytes = layout.metadata_bytes;
    estimate.value_bytes = layout.value_bytes;
    estimate.alignment_bytes = layout.alignment_bytes;
    estimate.entry_count = layout.entry_count;
    estimate.value_width = layout.value_width;
    estimate.value_bits = layout.value_bits;
    estimate.length_bits = layout.length_bits;
    estimate.block_size = layout.block_size;
    return estimate;
}

inline int tie_priority(Encoding encoding) noexcept {
    switch (encoding) {
    case Encoding::Plain:
        return 0;
    case Encoding::Rle:
        return 1;
    case Encoding::Dictionary:
        return 2;
    case Encoding::Delta:
        return 3;
    }
    return 4;
}

inline bool estimate_less(const EncodingEstimate& lhs, const EncodingEstimate& rhs) noexcept {
    if (lhs.total_bytes != rhs.total_bytes) {
        return lhs.total_bytes < rhs.total_bytes;
    }
    return tie_priority(lhs.encoding) < tie_priority(rhs.encoding);
}

template <ColumnValue T>
std::array<EncodingEstimate, 4> estimates_for(const Analysis& analysis) {
    std::array<EncodingEstimate, 4> result{};
    const auto width = static_cast<std::uint8_t>(sizeof(T));
    result[0] = estimate_from_layout(make_layout(Encoding::Plain, analysis, width));
    result[1] = estimate_from_layout(make_layout(Encoding::Dictionary, analysis, width));
    result[2] = estimate_from_layout(make_layout(Encoding::Rle, analysis, width));
    result[3] = estimate_from_layout(make_layout(Encoding::Delta, analysis, width));
    return result;
}

template <ColumnValue T>
void write_header(std::span<std::byte> bytes, const PageLayout& layout) {
    store_le<std::uint32_t>(bytes, 0, kMagic);
    store_le<std::uint16_t>(bytes, 4, kVersion);
    bytes[6] = std::byte{static_cast<unsigned char>(layout.encoding)};
    std::uint8_t flags = layout.bitmap_bytes != 0 ? 1u : 0u;
    if (std::is_signed_v<T>) {
        flags = static_cast<std::uint8_t>(flags | 2u);
    }
    bytes[7] = std::byte{flags};
    store_le<std::uint64_t>(bytes, 8, layout.rows);
    store_le<std::uint64_t>(bytes, 16, layout.total_bytes);
    store_le<std::uint64_t>(bytes, 24, layout.bitmap_offset);
    store_le<std::uint64_t>(bytes, 32, layout.payload_offset);
    store_le<std::uint64_t>(bytes, 40, layout.aux_offset);
    store_le<std::uint64_t>(bytes, 48, layout.entry_count);
    bytes[56] = std::byte{layout.value_width};
    bytes[57] = std::byte{layout.value_bits};
    bytes[58] = std::byte{layout.length_bits};
    bytes[59] = std::byte{layout.block_size};
    for (std::size_t i = 60; i < kHeaderBytes; ++i) {
        bytes[i] = std::byte{0};
    }
}

template <ColumnValue T>
std::vector<std::byte> build_page(const ColumnView<T>& view, const Analysis& analysis,
                                  const PageLayout& layout, const EncodeOptions& options) {
    using U = std::make_unsigned_t<T>;

    if (layout.total_bytes > options.max_encoded_bytes) {
        throw EncodingError("page exceeds the configured byte budget");
    }
    if (layout.encoding == Encoding::Dictionary &&
        layout.entry_count > options.max_dictionary_entries) {
        throw EncodingError("dictionary exceeds the configured entry limit");
    }
    if (layout.encoding == Encoding::Rle && layout.entry_count > options.max_rle_runs) {
        throw EncodingError("RLE exceeds the configured run limit");
    }
    if (layout.total_bytes >
        static_cast<std::uint64_t>(std::numeric_limits<std::size_t>::max())) {
        throw EncodingError("page size does not fit size_t");
    }

    std::vector<std::byte> bytes(static_cast<std::size_t>(layout.total_bytes), std::byte{0});
    const std::span<std::byte> output(bytes);
    write_header<T>(output, layout);

    if (layout.bitmap_bytes != 0) {
        const auto bitmap = view.null_bitmap();
        for (std::size_t i = 0; i < static_cast<std::size_t>(layout.bitmap_bytes); ++i) {
            output[static_cast<std::size_t>(layout.bitmap_offset) + i] =
                std::byte{bitmap[i]};
        }
    }

    switch (layout.encoding) {
    case Encoding::Plain: {
        for (std::size_t row = 0; row < view.size(); ++row) {
            const std::uint64_t offset =
                checked_add(layout.payload_offset,
                            checked_mul(row, layout.value_width));
            store_value<T>(output, offset, view.values()[row]);
        }
        break;
    }
    case Encoding::Dictionary: {
        std::unordered_map<T, std::uint64_t> dictionary;
        dictionary.reserve(static_cast<std::size_t>(
            std::min<std::uint64_t>(analysis.unique_count, 65536u)));
        BitWriter indices(output, checked_mul(layout.aux_offset, 8));

        for (const T value : view.values()) {
            const auto [it, inserted] =
                dictionary.emplace(value, static_cast<std::uint64_t>(dictionary.size()));
            if (inserted) {
                const std::uint64_t offset =
                    checked_add(layout.payload_offset,
                                checked_mul(it->second, layout.value_width));
                store_value<T>(output, offset, value);
            }
            indices.write(it->second, layout.value_bits);
        }
        if (dictionary.size() != layout.entry_count) {
            throw EncodingError("dictionary entry count changed during encoding");
        }
        break;
    }
    case Encoding::Rle: {
        BitWriter lengths(output, checked_mul(layout.aux_offset, 8));
        std::uint64_t runs = 0;
        std::uint64_t run_length = 0;
        for (std::size_t row = 0; row < view.size(); ++row) {
            if (row == 0 || view.values()[row] != view.values()[row - 1]) {
                if (row != 0) {
                    lengths.write(run_length, layout.length_bits);
                }
                const std::uint64_t offset =
                    checked_add(layout.payload_offset,
                                checked_mul(runs, layout.value_width));
                store_value<T>(output, offset, view.values()[row]);
                ++runs;
                run_length = 1;
            } else {
                ++run_length;
            }
        }
        if (!view.empty()) {
            lengths.write(run_length, layout.length_bits);
        }
        if (runs != layout.entry_count) {
            throw EncodingError("RLE run count changed during encoding");
        }
        break;
    }
    case Encoding::Delta: {
        std::uint64_t checkpoint = 0;
        std::uint64_t checkpoint_index = 0;
        while (checkpoint < layout.rows) {
            const std::uint64_t offset =
                checked_add(layout.payload_offset,
                            checked_mul(checkpoint_index, layout.value_width));
            store_value<T>(output, offset,
                           view.values()[static_cast<std::size_t>(checkpoint)]);
            ++checkpoint_index;
            if (layout.rows - checkpoint <= kDeltaBlockSize) {
                break;
            }
            checkpoint += kDeltaBlockSize;
        }
        if (checkpoint_index != layout.entry_count) {
            throw EncodingError("delta checkpoint count changed during encoding");
        }

        BitWriter deltas(output, checked_mul(layout.aux_offset, 8));
        if (!view.empty()) {
            U previous = std::bit_cast<U>(view.values()[0]);
            for (std::size_t row = 1; row < view.size(); ++row) {
                const U current = std::bit_cast<U>(view.values()[row]);
                const U difference = static_cast<U>(current - previous);
                deltas.write(static_cast<std::uint64_t>(zigzag_encode(difference)),
                             layout.value_bits);
                previous = current;
            }
        }
        break;
    }
    }

    return bytes;
}

} // namespace detail

template <ColumnValue T>
class ColumnPage {
public:
    ColumnPage() = default;
    ColumnPage(const ColumnPage&) = default;
    ColumnPage(ColumnPage&&) noexcept = default;
    ColumnPage& operator=(const ColumnPage&) = default;
    ColumnPage& operator=(ColumnPage&&) noexcept = default;

    static ColumnPage from_bytes(std::span<const std::byte> bytes) {
        return from_owned_bytes(std::vector<std::byte>(bytes.begin(), bytes.end()));
    }

    static ColumnPage from_owned_bytes(std::vector<std::byte> bytes) {
        ColumnPage page;
        page.bytes_ = std::move(bytes);
        page.parse();
        return page;
    }

    bool valid_page() const noexcept {
        return !bytes_.empty();
    }

    std::size_t size() const noexcept {
        return static_cast<std::size_t>(rows_);
    }

    std::uint64_t row_count() const noexcept {
        return rows_;
    }

    bool empty() const noexcept {
        return rows_ == 0;
    }

    std::size_t encoded_size() const noexcept {
        return bytes_.size();
    }

    Encoding encoding() const noexcept {
        return encoding_;
    }

    bool has_null_bitmap() const noexcept {
        return has_bitmap_;
    }

    bool has_nulls() const noexcept {
        return null_count_ != 0;
    }

    std::uint64_t null_count() const noexcept {
        return null_count_;
    }

    std::span<const std::byte> bytes() const noexcept {
        return std::span<const std::byte>(bytes_.data(), bytes_.size());
    }

    bool is_null(std::size_t row) const {
        check_row(row);
        if (!has_bitmap_) {
            return false;
        }
        return (std::to_integer<std::uint8_t>(bytes_[bitmap_offset_ + (row >> 3)]) &
                static_cast<std::uint8_t>(1u << (row & 7u))) != 0;
    }

    T value_at(std::size_t row) const {
        using U = std::make_unsigned_t<T>;
        check_row(row);

        switch (encoding_) {
        case Encoding::Plain:
            return detail::load_value<T>(
                bytes_, detail::checked_add(payload_offset_, row * sizeof(T)));
        case Encoding::Dictionary: {
            detail::BitReader indices(
                bytes_, detail::checked_add(detail::checked_mul(aux_offset_, 8),
                                            detail::checked_mul(row, value_bits_)));
            const std::uint64_t index = indices.read(value_bits_);
            if (index >= entry_count_) {
                throw PageFormatError("dictionary index is out of range");
            }
            return detail::load_value<T>(
                bytes_, detail::checked_add(payload_offset_, index * sizeof(T)));
        }
        case Encoding::Rle: {
            const auto it = std::upper_bound(run_ends_.begin(), run_ends_.end(),
                                             static_cast<std::uint64_t>(row));
            if (it == run_ends_.end()) {
                throw PageFormatError("RLE run index is out of range");
            }
            const auto run = static_cast<std::uint64_t>(it - run_ends_.begin());
            return detail::load_value<T>(
                bytes_, detail::checked_add(payload_offset_, run * sizeof(T)));
        }
        case Encoding::Delta: {
            const std::uint64_t checkpoint_row =
                (static_cast<std::uint64_t>(row) / block_size_) * block_size_;
            const std::uint64_t checkpoint_index =
                static_cast<std::uint64_t>(row) / block_size_;
            U accumulator = std::bit_cast<U>(detail::load_value<T>(
                bytes_, detail::checked_add(payload_offset_,
                                            checkpoint_index * sizeof(T))));
            detail::BitReader deltas(
                bytes_, detail::checked_add(detail::checked_mul(aux_offset_, 8),
                                            detail::checked_mul(checkpoint_row, value_bits_)));
            for (std::uint64_t current = checkpoint_row + 1;
                 current <= static_cast<std::uint64_t>(row); ++current) {
                const std::uint64_t encoded = deltas.read(value_bits_);
                accumulator =
                    static_cast<U>(accumulator + detail::zigzag_decode<U>(encoded));
            }
            return std::bit_cast<T>(accumulator);
        }
        }
        throw PageFormatError("unknown page encoding");
    }

    std::optional<T> at(std::size_t row) const {
        if (is_null(row)) {
            return std::nullopt;
        }
        return value_at(row);
    }

    T operator[](std::size_t row) const {
        return value_at(row);
    }

    Column<T> decode() const {
        if (rows_ > static_cast<std::uint64_t>(std::numeric_limits<std::size_t>::max())) {
            throw PageFormatError("page row count does not fit size_t");
        }
        const auto count = static_cast<std::size_t>(rows_);
        Column<T> result;
        if (count > result.values.max_size()) {
            throw PageFormatError("page row count exceeds vector capacity");
        }
        result.values.resize(count);
        result.nulls.resize(count);
        for (std::size_t row = 0; row < result.values.size(); ++row) {
            result.values[row] = value_at(row);
            if (is_null(row)) {
                result.nulls.set_null(row);
            }
        }
        return result;
    }

private:
    void check_row(std::size_t row) const {
        if (row >= rows_) {
            throw std::out_of_range("ColumnPage row out of range");
        }
    }

    void parse() {
        if (bytes_.size() < detail::kHeaderBytes) {
            throw PageFormatError("page is shorter than its header");
        }
        const std::span<const std::byte> input(bytes_.data(), bytes_.size());
        if (detail::load_le<std::uint32_t>(input, 0) != detail::kMagic) {
            throw PageFormatError("bad page magic");
        }
        if (detail::load_le<std::uint16_t>(input, 4) != detail::kVersion) {
            throw PageFormatError("unsupported page version");
        }

        const auto encoding_byte = std::to_integer<std::uint8_t>(input[6]);
        if (encoding_byte > static_cast<std::uint8_t>(Encoding::Delta)) {
            throw PageFormatError("unknown page encoding");
        }
        const Encoding encoding = static_cast<Encoding>(encoding_byte);
        const std::uint8_t flags = std::to_integer<std::uint8_t>(input[7]);
        if ((flags & static_cast<std::uint8_t>(~3u)) != 0) {
            throw PageFormatError("unknown page flags");
        }
        const bool has_bitmap = (flags & 1u) != 0;
        const bool signed_values = (flags & 2u) != 0;
        if (signed_values != std::is_signed_v<T>) {
            throw PageFormatError("page value type does not match T");
        }

        const std::uint64_t rows = detail::load_le<std::uint64_t>(input, 8);
        const std::uint64_t total_bytes = detail::load_le<std::uint64_t>(input, 16);
        const std::uint64_t bitmap_offset = detail::load_le<std::uint64_t>(input, 24);
        const std::uint64_t payload_offset = detail::load_le<std::uint64_t>(input, 32);
        const std::uint64_t aux_offset = detail::load_le<std::uint64_t>(input, 40);
        const std::uint64_t entry_count = detail::load_le<std::uint64_t>(input, 48);
        const auto value_width = std::to_integer<std::uint8_t>(input[56]);
        const auto value_bits = std::to_integer<std::uint8_t>(input[57]);
        const auto length_bits = std::to_integer<std::uint8_t>(input[58]);
        const auto block_size = std::to_integer<std::uint8_t>(input[59]);

        if (value_width != sizeof(T)) {
            throw PageFormatError("page value width does not match T");
        }
        if (rows > static_cast<std::uint64_t>(std::numeric_limits<std::size_t>::max())) {
            throw PageFormatError("page row count does not fit size_t");
        }
        if (total_bytes != bytes_.size()) {
            throw PageFormatError("page size does not match its header");
        }
        for (std::size_t i = 60; i < detail::kHeaderBytes; ++i) {
            if (input[i] != std::byte{0}) {
                throw PageFormatError("non-zero reserved header bytes");
            }
        }

        const std::uint64_t expected_bitmap_bytes =
            has_bitmap ? detail::bitmap_byte_count(rows) : 0;
        if (has_bitmap && rows == 0) {
            throw PageFormatError("empty page has a null bitmap");
        }
        const std::uint64_t expected_bitmap_offset =
            has_bitmap ? detail::kHeaderBytes : 0;
        if (bitmap_offset != expected_bitmap_offset) {
            throw PageFormatError("unexpected null bitmap offset");
        }
        const std::uint64_t expected_payload =
            detail::align_up(
                detail::checked_add(detail::kHeaderBytes, expected_bitmap_bytes), 8);
        if (payload_offset != expected_payload) {
            throw PageFormatError("unexpected payload offset");
        }

        std::vector<std::uint64_t> run_ends;
        std::uint64_t metadata_bytes = 0;
        std::uint64_t value_bytes = 0;

        switch (encoding) {
        case Encoding::Plain: {
            if (entry_count != rows || aux_offset != 0 ||
                value_bits != static_cast<std::uint8_t>(sizeof(T) * 8u) ||
                length_bits != 0 || block_size != 0) {
                throw PageFormatError("invalid plain page metadata");
            }
            value_bytes = detail::checked_mul(rows, sizeof(T));
            break;
        }
        case Encoding::Dictionary: {
            const unsigned expected_bits =
                entry_count > 1 ? detail::bits_required(entry_count - 1) : 0;
            if ((rows == 0 && entry_count != 0) || (rows != 0 && entry_count == 0) ||
                value_bits != expected_bits || length_bits != 0 || block_size != 0) {
                throw PageFormatError("invalid dictionary page metadata");
            }
            metadata_bytes = detail::checked_mul(entry_count, sizeof(T));
            value_bytes =
                detail::checked_add(detail::checked_mul(rows, value_bits), 7) / 8;
            if (aux_offset != detail::checked_add(payload_offset, metadata_bytes)) {
                throw PageFormatError("unexpected dictionary index offset");
            }
            break;
        }
        case Encoding::Rle: {
            if ((rows == 0 && entry_count != 0) || (rows != 0 && entry_count == 0) ||
                value_bits != static_cast<std::uint8_t>(sizeof(T) * 8u) ||
                block_size != 0 || (rows != 0 && length_bits == 0) ||
                length_bits > 64) {
                throw PageFormatError("invalid RLE page metadata");
            }
            metadata_bytes = detail::checked_mul(entry_count, sizeof(T));
            value_bytes =
                detail::checked_add(detail::checked_mul(entry_count, length_bits), 7) / 8;
            if (aux_offset != detail::checked_add(payload_offset, metadata_bytes)) {
                throw PageFormatError("unexpected RLE length offset");
            }
            if (entry_count != 0) {
                if (aux_offset > std::numeric_limits<std::uint64_t>::max() / 8u) {
                    throw PageFormatError("RLE length bit offset overflow");
                }
                detail::BitReader lengths(input, aux_offset * 8u);
                run_ends.reserve(static_cast<std::size_t>(entry_count));
                std::uint64_t sum = 0;
                std::uint64_t max_length = 0;
                for (std::uint64_t run = 0; run < entry_count; ++run) {
                    const std::uint64_t length = lengths.read(length_bits);
                    if (length == 0) {
                        throw PageFormatError("zero-length RLE run");
                    }
                    sum = detail::checked_add(sum, length);
                    if (sum > rows) {
                        throw PageFormatError("RLE runs exceed the row count");
                    }
                    max_length = std::max(max_length, length);
                    run_ends.push_back(sum);
                }
                if (sum != rows) {
                    throw PageFormatError("RLE runs do not cover the row count");
                }
                if (detail::bits_required(max_length) != length_bits) {
                    throw PageFormatError("non-canonical RLE length width");
                }
            }
            break;
        }
        case Encoding::Delta: {
            const std::uint64_t expected_checkpoints =
                rows == 0 ? 0 : ((rows - 1) / detail::kDeltaBlockSize) + 1;
            if (entry_count != expected_checkpoints ||
                block_size != detail::kDeltaBlockSize || length_bits != 0 ||
                value_bits > sizeof(T) * 8u) {
                throw PageFormatError("invalid delta page metadata");
            }
            metadata_bytes = detail::checked_mul(entry_count, sizeof(T));
            value_bytes =
                detail::checked_add(
                    detail::checked_mul(rows == 0 ? 0 : rows - 1, value_bits), 7) /
                8;
            if (aux_offset != detail::checked_add(payload_offset, metadata_bytes)) {
                throw PageFormatError("unexpected delta offset");
            }
            break;
        }
        }

        const std::uint64_t content_end =
            detail::checked_add(payload_offset,
                                detail::checked_add(metadata_bytes, value_bytes));
        if (detail::align_up(content_end, 8) != total_bytes) {
            throw PageFormatError("page section sizes do not match the total size");
        }
        if (total_bytes > bytes_.size()) {
            throw PageFormatError("page sections exceed the buffer");
        }

        std::uint64_t nulls = 0;
        if (has_bitmap) {
            for (std::size_t row = 0; row < static_cast<std::size_t>(rows); ++row) {
                if ((std::to_integer<std::uint8_t>(
                         input[bitmap_offset + (row >> 3)]) &
                     static_cast<std::uint8_t>(1u << (row & 7u))) != 0) {
                    ++nulls;
                }
            }
        }

        encoding_ = encoding;
        rows_ = rows;
        bitmap_offset_ = bitmap_offset;
        payload_offset_ = payload_offset;
        aux_offset_ = aux_offset;
        entry_count_ = entry_count;
        value_bits_ = value_bits;
        block_size_ = block_size;
        has_bitmap_ = has_bitmap;
        null_count_ = nulls;
        run_ends_ = std::move(run_ends);
    }

    std::vector<std::byte> bytes_;
    Encoding encoding_ = Encoding::Plain;
    std::uint64_t rows_ = 0;
    std::uint64_t bitmap_offset_ = 0;
    std::uint64_t payload_offset_ = 0;
    std::uint64_t aux_offset_ = 0;
    std::uint64_t entry_count_ = 0;
    std::uint8_t value_bits_ = 0;
    std::uint8_t block_size_ = 0;
    bool has_bitmap_ = false;
    std::uint64_t null_count_ = 0;
    std::vector<std::uint64_t> run_ends_;
};

template <ColumnValue T>
std::array<EncodingEstimate, 4> estimate_encodings(const ColumnView<T>& view) {
    const auto analysis = detail::analyze(view);
    return detail::estimates_for<T>(analysis);
}

template <ColumnValue T>
std::array<EncodingEstimate, 4> estimate_encodings(const Column<T>& column) {
    return estimate_encodings(column.view());
}

template <ColumnValue T>
EncodingEstimate estimate_encoding(const ColumnView<T>& view, Encoding encoding) {
    const auto analysis = detail::analyze(view);
    return detail::estimate_from_layout(
        detail::make_layout(encoding, analysis, static_cast<std::uint8_t>(sizeof(T))));
}

template <ColumnValue T>
EncodingEstimate estimate_encoding(const Column<T>& column, Encoding encoding) {
    return estimate_encoding(column.view(), encoding);
}

template <ColumnValue T>
EncodingEstimate select_encoding(const ColumnView<T>& view) {
    const auto estimates = estimate_encodings(view);
    EncodingEstimate best = estimates[0];
    for (std::size_t i = 1; i < estimates.size(); ++i) {
        if (detail::estimate_less(estimates[i], best)) {
            best = estimates[i];
        }
    }
    return best;
}

template <ColumnValue T>
EncodingEstimate select_encoding(const Column<T>& column) {
    return select_encoding(column.view());
}

template <ColumnValue T>
Encoding choose_encoding(const ColumnView<T>& view) {
    return select_encoding(view).encoding;
}

template <ColumnValue T>
Encoding choose_encoding(const Column<T>& column) {
    return choose_encoding(column.view());
}

template <ColumnValue T>
ColumnPage<T> encode_column(const ColumnView<T>& view, EncodeOptions options = {}) {
    const auto analysis = detail::analyze(view);
    const auto estimates = detail::estimates_for<T>(analysis);
    const auto width = static_cast<std::uint8_t>(sizeof(T));

    std::array<std::size_t, 4> order{0, 1, 2, 3};
    std::sort(order.begin(), order.end(), [&](std::size_t lhs, std::size_t rhs) {
        return detail::estimate_less(estimates[lhs], estimates[rhs]);
    });

    std::array<Encoding, 4> attempts{};
    std::size_t attempt_count = 0;
    if (options.force_encoding.has_value()) {
        attempts[attempt_count++] = *options.force_encoding;
        if (*options.force_encoding != Encoding::Plain) {
            attempts[attempt_count++] = Encoding::Plain;
        }
    } else {
        for (const std::size_t index : order) {
            attempts[attempt_count++] = estimates[index].encoding;
        }
    }

    std::exception_ptr last_failure;
    for (std::size_t attempt = 0; attempt < attempt_count; ++attempt) {
        try {
            const auto layout = detail::make_layout(attempts[attempt], analysis, width);
            auto bytes = detail::build_page(view, analysis, layout, options);
            auto page = ColumnPage<T>::from_owned_bytes(std::move(bytes));
            if (page.encoded_size() != layout.total_bytes) {
                throw EncodingError("encoder produced a page with an unexpected size");
            }
            return page;
        } catch (...) {
            last_failure = std::current_exception();
        }
    }
    if (last_failure) {
        std::rethrow_exception(last_failure);
    }
    throw EncodingError("no encoding produced a page");
}

template <ColumnValue T>
ColumnPage<T> encode_column(const Column<T>& column, EncodeOptions options = {}) {
    return encode_column(column.view(), std::move(options));
}

// Strong guarantee: destination is replaced only after a complete page has been
// built and validated. A failed attempt never leaves partial bytes in it.
template <ColumnValue T>
void encode_into(ColumnPage<T>& destination, const ColumnView<T>& view,
                 EncodeOptions options = {}) {
    auto page = encode_column(view, std::move(options));
    destination = std::move(page);
}

template <ColumnValue T>
void encode_into(ColumnPage<T>& destination, const Column<T>& column,
                 EncodeOptions options = {}) {
    encode_into(destination, column.view(), std::move(options));
}

template <ColumnValue T>
Column<T> decode_column(const ColumnPage<T>& page) {
    return page.decode();
}

} // namespace dlks_formal
