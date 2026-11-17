#include "dlks_formal.hpp"

#include <algorithm>
#include <bit>
#include <cstddef>
#include <cstdint>
#include <iostream>
#include <limits>
#include <random>
#include <stdexcept>
#include <string>
#include <type_traits>
#include <utility>
#include <vector>

namespace {

using dlks_formal::Column;
using dlks_formal::ColumnPage;
using dlks_formal::EncodeOptions;
using dlks_formal::Encoding;
using dlks_formal::EncodingEstimate;
using dlks_formal::NullBitmap;

class TestFailure : public std::runtime_error {
public:
    explicit TestFailure(const std::string& message) : std::runtime_error(message) {}
};

#define CHECK(condition)                                                                 \
    do {                                                                                 \
        if (!(condition)) {                                                              \
            throw TestFailure(std::string(__FILE__) + ":" + std::to_string(__LINE__) +   \
                              ": check failed: " #condition);                            \
        }                                                                                \
    } while (false)

enum class Pattern {
    Random,
    Constant,
    LowCardinality,
    Monotonic,
    Runs,
    Alternating,
    Narrow,
};

template <class T>
using Unsigned = std::make_unsigned_t<T>;

template <class T>
T bits_to_value(Unsigned<T> bits) {
    return std::bit_cast<T>(bits);
}

template <class T>
T random_value(std::mt19937_64& rng) {
    return bits_to_value<T>(static_cast<Unsigned<T>>(rng()));
}

template <class T>
Column<T> make_column(std::mt19937_64& rng, Pattern pattern, std::size_t rows,
                      int null_mode) {
    Column<T> column(rows);
    using U = Unsigned<T>;

    const U constant = static_cast<U>(rng());
    U current = static_cast<U>(rng());
    U run_value = static_cast<U>(rng());
    std::size_t run_left = 0;

    for (std::size_t row = 0; row < rows; ++row) {
        switch (pattern) {
        case Pattern::Random:
            column.values[row] = bits_to_value<T>(static_cast<U>(rng()));
            break;
        case Pattern::Constant:
            column.values[row] = bits_to_value<T>(constant);
            break;
        case Pattern::LowCardinality:
            column.values[row] = bits_to_value<T>(static_cast<U>(rng() % 7u));
            break;
        case Pattern::Monotonic:
            column.values[row] = bits_to_value<T>(current);
            current = static_cast<U>(current + static_cast<U>(rng() % 5u));
            break;
        case Pattern::Runs:
            if (run_left == 0) {
                run_value = static_cast<U>(rng());
                run_left = 1u + static_cast<std::size_t>(rng() % 67u);
            }
            column.values[row] = bits_to_value<T>(run_value);
            --run_left;
            break;
        case Pattern::Alternating:
            column.values[row] = bits_to_value<T>(static_cast<U>(rng() % 3u));
            break;
        case Pattern::Narrow: {
            constexpr unsigned width = sizeof(T) * 8u;
            constexpr unsigned used = width < 5u ? width : 5u;
            const U mask = static_cast<U>((U{1} << used) - 1u);
            column.values[row] = bits_to_value<T>(static_cast<U>(rng()) & mask);
            break;
        }
        }
    }

    if (null_mode == 1) {
        for (std::size_t row = 0; row < rows; ++row) {
            if ((rng() % 11u) < 3u) {
                column.nulls.set_null(row);
            }
        }
    } else if (null_mode == 2) {
        for (std::size_t row = 0; row < rows; ++row) {
            column.nulls.set_null(row);
        }
    }
    return column;
}

template <class T>
void check_row_against_source(const Column<T>& source, const ColumnPage<T>& page,
                              std::size_t row) {
    CHECK(page.is_null(row) == source.is_null(row));
    CHECK(page.value_at(row) == source.values[row]);
    const auto optional = page.at(row);
    CHECK(optional.has_value() == !source.is_null(row));
    if (optional.has_value()) {
        CHECK(*optional == source.values[row]);
    }
}

template <class T>
void verify_page(const Column<T>& source, const ColumnPage<T>& page) {
    CHECK(page.valid_page());
    CHECK(page.size() == source.size());
    CHECK(page.row_count() == source.size());
    CHECK(page.encoded_size() % 8u == 0);
    CHECK(page.has_nulls() == source.nulls.any_null());
    CHECK(page.null_count() == source.nulls.null_count());
    CHECK(page.has_null_bitmap() == source.nulls.any_null());

    const auto decoded = page.decode();
    CHECK(decoded.size() == source.size());
    for (std::size_t row = 0; row < source.size(); ++row) {
        CHECK(decoded.values[row] == source.values[row]);
        CHECK(decoded.is_null(row) == source.is_null(row));
    }

    const auto reloaded = ColumnPage<T>::from_bytes(page.bytes());
    CHECK(reloaded.encoding() == page.encoding());
    CHECK(reloaded.encoded_size() == page.encoded_size());
    CHECK(reloaded.null_count() == page.null_count());

    for (std::size_t row = 0; row < source.size(); ++row) {
        check_row_against_source(source, page, row);
        check_row_against_source(source, reloaded, row);
    }

    for (std::size_t probe = 0; probe < 32 && !source.empty(); ++probe) {
        const std::size_t row =
            static_cast<std::size_t>(probe * 2654435761u) % source.size();
        check_row_against_source(source, page, row);
        check_row_against_source(source, reloaded, row);
    }
}

template <class T>
void verify_estimates_and_encodings(const Column<T>& source) {
    const auto estimates = dlks_formal::estimate_encodings(source);
    CHECK(estimates.size() == 4);

    const std::uint64_t expected_bitmap_bytes =
        source.nulls.any_null() ? (source.size() + 7u) / 8u : 0u;
    std::uint64_t minimum = std::numeric_limits<std::uint64_t>::max();

    for (std::size_t i = 0; i < estimates.size(); ++i) {
        const auto& estimate = estimates[i];
        CHECK(estimate.encoding == static_cast<Encoding>(i));
        CHECK(estimate.header_bytes == 64u);
        CHECK(estimate.null_bitmap_bytes == expected_bitmap_bytes);
        CHECK(estimate.value_width == sizeof(T));
        CHECK(estimate.alignment_bytes < 16u);
        CHECK(estimate.total_bytes % 8u == 0);
        CHECK(estimate.total_bytes == estimate.header_bytes +
                                         estimate.null_bitmap_bytes +
                                         estimate.metadata_bytes +
                                         estimate.value_bytes +
                                         estimate.alignment_bytes);

        EncodeOptions options;
        options.force_encoding = estimate.encoding;
        const auto page = dlks_formal::encode_column(source, options);
        CHECK(page.encoding() == estimate.encoding);
        CHECK(page.encoded_size() == estimate.total_bytes);
        verify_page(source, page);

        minimum = std::min(minimum, estimate.total_bytes);
    }

    const auto selected = dlks_formal::select_encoding(source);
    CHECK(selected.total_bytes == minimum);
    CHECK(dlks_formal::choose_encoding(source) == selected.encoding);

    const auto automatic = dlks_formal::encode_column(source);
    CHECK(automatic.encoding() == selected.encoding);
    CHECK(automatic.encoded_size() == minimum);
    verify_page(source, automatic);
}

template <class T>
void run_type_properties(std::mt19937_64& rng) {
    constexpr Pattern patterns[] = {
        Pattern::Random,       Pattern::Constant,    Pattern::LowCardinality,
        Pattern::Monotonic,    Pattern::Runs,        Pattern::Alternating,
        Pattern::Narrow,
    };

    for (const Pattern pattern : patterns) {
        for (int round = 0; round < 3; ++round) {
            const std::size_t rows = static_cast<std::size_t>(rng() % 260u);
            const int null_mode = static_cast<int>(rng() % 3u);
            const auto column = make_column<T>(rng, pattern, rows, null_mode);
            verify_estimates_and_encodings(column);
        }
    }

    for (const std::size_t rows :
         {std::size_t{0}, std::size_t{1}, std::size_t{7}, std::size_t{8},
          std::size_t{9}, std::size_t{31}, std::size_t{32}, std::size_t{33},
          std::size_t{63}, std::size_t{64}, std::size_t{65}, std::size_t{129}}) {
        const auto column = make_column<T>(rng, Pattern::Random, rows,
                                           static_cast<int>(rng() % 3u));
        verify_estimates_and_encodings(column);
    }
}

template <class T>
Column<T> column_from(std::vector<T> values) {
    Column<T> column(values.size());
    column.values = std::move(values);
    return column;
}

void test_known_selection_costs() {
    {
        std::vector<std::uint32_t> values(4096, 42u);
        const auto column = column_from(std::move(values));
        CHECK(dlks_formal::choose_encoding(column) == Encoding::Rle);
    }
    {
        std::vector<std::uint32_t> values(4096);
        for (std::size_t i = 0; i < values.size(); ++i) {
            values[i] = static_cast<std::uint32_t>(i % 4u);
        }
        const auto column = column_from(std::move(values));
        CHECK(dlks_formal::choose_encoding(column) == Encoding::Dictionary);
    }
    {
        std::vector<std::uint32_t> values(4096);
        for (std::size_t i = 0; i < values.size(); ++i) {
            values[i] = static_cast<std::uint32_t>(1000u + i);
        }
        const auto column = column_from(std::move(values));
        CHECK(dlks_formal::choose_encoding(column) == Encoding::Delta);
    }
    {
        std::mt19937_64 rng(0x123456789abcdef0ULL);
        std::vector<std::uint64_t> values(4096);
        for (auto& value : values) {
            value = rng();
        }
        const auto column = column_from(std::move(values));
        CHECK(dlks_formal::choose_encoding(column) == Encoding::Plain);
    }
    {
        std::vector<std::uint8_t> values(9, 7u);
        const auto column = column_from(std::move(values));
        CHECK(dlks_formal::choose_encoding(column) == Encoding::Rle);
    }
    {
        Column<std::int64_t> empty;
        CHECK(dlks_formal::choose_encoding(empty) == Encoding::Plain);
        const auto page = dlks_formal::encode_column(empty);
        CHECK(page.encoded_size() == 64u);
        verify_page(empty, page);
    }
}

void test_null_bitmap_api() {
    NullBitmap bitmap(10);
    CHECK(bitmap.size() == 10);
    CHECK(bitmap.null_count() == 0);
    CHECK(!bitmap.is_null(0));
    bitmap.set_null(1);
    bitmap.set_null(9);
    CHECK(bitmap.is_null(1));
    CHECK(bitmap.is_valid(2));
    CHECK(bitmap.null_count() == 2);
    CHECK(bitmap.any_null());
    CHECK(bitmap.data().size() == 2);

    bitmap.resize(20, true);
    CHECK(bitmap.size() == 20);
    CHECK(bitmap.null_count() == 2);
    CHECK(!bitmap.is_null(15));
    bitmap.set_null(15);
    CHECK(bitmap.null_count() == 3);

    bitmap.resize(3);
    CHECK(bitmap.size() == 3);
    CHECK(bitmap.is_null(1));
    CHECK(bitmap.null_count() == 1);

    const auto all_null = NullBitmap::all_null(17);
    CHECK(all_null.null_count() == 17);
    all_null.data();
    auto mutable_copy = all_null;
    mutable_copy.set_valid(0);
    CHECK(mutable_copy.null_count() == 16);
}

void test_extreme_values_and_delta_blocks() {
    {
        const auto column = column_from<std::int64_t>({
            std::numeric_limits<std::int64_t>::min(),
            std::numeric_limits<std::int64_t>::max(),
            std::numeric_limits<std::int64_t>::min(),
            std::numeric_limits<std::int64_t>::max(),
            0,
            -1,
            1,
        });
        verify_estimates_and_encodings(column);
    }
    {
        const auto column = column_from<std::uint64_t>({
            0,
            std::numeric_limits<std::uint64_t>::max(),
            0,
            1,
            std::numeric_limits<std::uint64_t>::max() - 1u,
            2,
        });
        verify_estimates_and_encodings(column);
    }
    {
        Column<std::int32_t> column(1025);
        for (std::size_t i = 0; i < column.size(); ++i) {
            column.values[i] = static_cast<std::int32_t>(-500 + static_cast<int>(i));
        }
        EncodeOptions options;
        options.force_encoding = Encoding::Delta;
        const auto page = dlks_formal::encode_column(column, options);
        CHECK(page.encoding() == Encoding::Delta);
        verify_page(column, page);
        CHECK(page.value_at(0) == -500);
        CHECK(page.value_at(31) == -469);
        CHECK(page.value_at(32) == -468);
        CHECK(page.value_at(1024) == 524);
    }
}

void test_failure_fallback_and_strong_guarantee() {
    Column<std::uint64_t> unique_column(2000);
    for (std::size_t i = 0; i < unique_column.size(); ++i) {
        unique_column.values[i] = i;
    }
    unique_column.nulls.set_null(17);

    auto stable = dlks_formal::encode_column(unique_column);
    const std::vector<std::byte> before(stable.bytes().begin(), stable.bytes().end());

    EncodeOptions impossible;
    impossible.force_encoding = Encoding::Plain;
    impossible.max_encoded_bytes = 1;
    bool threw = false;
    try {
        dlks_formal::encode_into(stable, unique_column, impossible);
    } catch (const dlks_formal::CodecError&) {
        threw = true;
    }
    CHECK(threw);
    CHECK(stable.bytes().size() == before.size());
    CHECK(std::equal(stable.bytes().begin(), stable.bytes().end(), before.begin()));
    verify_page(unique_column, stable);

    EncodeOptions dictionary_failure;
    dictionary_failure.force_encoding = Encoding::Dictionary;
    dictionary_failure.max_dictionary_entries = 8;
    const auto fallback = dlks_formal::encode_column(unique_column, dictionary_failure);
    CHECK(fallback.encoding() == Encoding::Plain);
    CHECK(fallback.encoded_size() ==
          dlks_formal::estimate_encoding(unique_column, Encoding::Plain).total_bytes);
    verify_page(unique_column, fallback);

    EncodeOptions automatic_failure;
    automatic_failure.max_dictionary_entries = 8;
    automatic_failure.max_encoded_bytes =
        dlks_formal::estimate_encoding(unique_column, Encoding::Plain).total_bytes;
    const auto automatic = dlks_formal::encode_column(unique_column, automatic_failure);
    CHECK(automatic.encoding() != Encoding::Dictionary);
    verify_page(unique_column, automatic);
}

void test_corrupt_pages_are_rejected() {
    Column<std::uint32_t> column(40);
    for (std::size_t i = 0; i < column.size(); ++i) {
        column.values[i] = static_cast<std::uint32_t>(i * 3u);
    }
    const auto page = dlks_formal::encode_column(column);
    std::vector<std::byte> bytes(page.bytes().begin(), page.bytes().end());
    CHECK(bytes.size() >= 64);

    auto expect_bad = [](const std::vector<std::byte>& candidate) {
        bool rejected = false;
        try {
            (void)ColumnPage<std::uint32_t>::from_bytes(candidate);
        } catch (const dlks_formal::PageFormatError&) {
            rejected = true;
        }
        CHECK(rejected);
    };

    auto bad_magic = bytes;
    bad_magic[0] ^= std::byte{0xff};
    expect_bad(bad_magic);

    auto truncated = bytes;
    truncated.pop_back();
    expect_bad(truncated);

    auto bad_total = bytes;
    bad_total[16] ^= std::byte{0x01};
    expect_bad(bad_total);

    bool wrong_type_rejected = false;
    try {
        (void)ColumnPage<std::int32_t>::from_bytes(page.bytes());
    } catch (const dlks_formal::PageFormatError&) {
        wrong_type_rejected = true;
    }
    CHECK(wrong_type_rejected);
}

} // namespace

int main() {
    try {
        test_null_bitmap_api();
        test_known_selection_costs();
        test_extreme_values_and_delta_blocks();
        test_failure_fallback_and_strong_guarantee();
        test_corrupt_pages_are_rejected();

        std::mt19937_64 rng(0x9e3779b97f4a7c15ULL);
        run_type_properties<std::uint8_t>(rng);
        run_type_properties<std::uint16_t>(rng);
        run_type_properties<std::uint32_t>(rng);
        run_type_properties<std::uint64_t>(rng);
        run_type_properties<std::int8_t>(rng);
        run_type_properties<std::int16_t>(rng);
        run_type_properties<std::int32_t>(rng);
        run_type_properties<std::int64_t>(rng);
    } catch (const std::exception& error) {
        std::cerr << "column codec tests failed: " << error.what() << '\n';
        return 1;
    }
    std::cout << "column codec tests passed\n";
    return 0;
}
