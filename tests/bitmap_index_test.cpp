#include "dlks_formal.hpp"

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <iostream>
#include <random>
#include <sstream>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace {

using dlks_formal::BitmapIndex;
using Bits = std::vector<bool>;

class TestFailure : public std::runtime_error {
public:
    using std::runtime_error::runtime_error;
};

[[noreturn]] void fail(const std::string& message) {
    throw TestFailure(message);
}

void require(bool condition, const std::string& message) {
    if (!condition) {
        fail(message);
    }
}

Bits decode_mask(std::size_t universe_size, std::uint64_t mask) {
    Bits bits(universe_size, false);
    for (std::size_t index = 0; index < universe_size; ++index) {
        bits[index] = ((mask >> index) & 1U) != 0;
    }
    return bits;
}

BitmapIndex from_mask(std::size_t universe_size, std::uint64_t mask) {
    return BitmapIndex(decode_mask(universe_size, mask));
}

Bits bit_and(const Bits& left, const Bits& right) {
    Bits result(left.size(), false);
    for (std::size_t index = 0; index < left.size(); ++index) {
        result[index] = left[index] && right[index];
    }
    return result;
}

Bits bit_or(const Bits& left, const Bits& right) {
    Bits result(left.size(), false);
    for (std::size_t index = 0; index < left.size(); ++index) {
        result[index] = left[index] || right[index];
    }
    return result;
}

Bits bit_not(const Bits& value) {
    Bits result(value.size(), false);
    for (std::size_t index = 0; index < value.size(); ++index) {
        result[index] = !value[index];
    }
    return result;
}

Bits bit_and_not(const Bits& left, const Bits& right) {
    Bits result(left.size(), false);
    for (std::size_t index = 0; index < left.size(); ++index) {
        result[index] = left[index] && !right[index];
    }
    return result;
}

Bits bit_xor(const Bits& left, const Bits& right) {
    Bits result(left.size(), false);
    for (std::size_t index = 0; index < left.size(); ++index) {
        result[index] = left[index] != right[index];
    }
    return result;
}

std::size_t true_count(const Bits& bits) {
    return static_cast<std::size_t>(
        std::count(bits.begin(), bits.end(), true));
}

std::size_t true_run_count(const Bits& bits) {
    std::size_t runs = 0;
    bool inside_run = false;
    for (const bool value : bits) {
        if (value && !inside_run) {
            ++runs;
        }
        inside_run = value;
    }
    return runs;
}

void check_bitmap(const BitmapIndex& bitmap, const Bits& expected,
                  const std::string& context) {
    if (bitmap.universe_size() != expected.size()) {
        std::ostringstream message;
        message << context << ": universe is " << bitmap.universe_size()
                << ", expected " << expected.size();
        fail(message.str());
    }
    if (!bitmap.is_canonical()) {
        fail(context + ": bitmap runs are not canonical");
    }

    const Bits actual = bitmap.to_bits();
    if (actual != expected) {
        std::ostringstream message;
        message << context << ": bitmap differs at";
        for (std::size_t index = 0; index < expected.size(); ++index) {
            if (actual[index] != expected[index]) {
                message << ' ' << index;
            }
        }
        fail(message.str());
    }

    const std::size_t expected_count = true_count(expected);
    if (bitmap.count() != expected_count ||
        bitmap.cardinality() != expected_count ||
        dlks_formal::cardinality(bitmap) != expected_count) {
        std::ostringstream message;
        message << context << ": cardinality is " << bitmap.count()
                << ", expected " << expected_count;
        fail(message.str());
    }
    if (bitmap.empty() != (expected_count == 0) ||
        bitmap.none() != (expected_count == 0)) {
        fail(context + ": empty/none state differs");
    }
    if (bitmap.all() !=
        (expected_count == expected.size())) {
        fail(context + ": all state differs");
    }
    if (bitmap.run_count() != true_run_count(expected)) {
        std::ostringstream message;
        message << context << ": run count is " << bitmap.run_count()
                << ", expected " << true_run_count(expected);
        fail(message.str());
    }

    std::vector<std::size_t> expected_indices;
    for (std::size_t index = 0; index < expected.size(); ++index) {
        const bool value = expected[index];
        if (bitmap.test(index) != value ||
            bitmap.contains(index) != value ||
            bitmap[index] != value) {
            std::ostringstream message;
            message << context << ": test/contains/operator[] differs at "
                    << index;
            fail(message.str());
        }
        if (value) {
            expected_indices.push_back(index);
        }
    }
    if (bitmap.to_indices() != expected_indices) {
        fail(context + ": to_indices differs");
    }
}

void test_empty_and_boundaries() {
    const BitmapIndex empty_zero;
    check_bitmap(empty_zero, Bits{}, "default empty");
    check_bitmap(~empty_zero, Bits{}, "NOT empty universe");

    BitmapIndex empty_one(1);
    check_bitmap(empty_one, Bits{false}, "one-bit empty");
    check_bitmap(~empty_one, Bits{true}, "one-bit NOT empty");
    empty_one.set(0);
    check_bitmap(empty_one, Bits{true}, "one-bit set");
    empty_one.flip();
    check_bitmap(empty_one, Bits{false}, "one-bit flip");

    BitmapIndex full = BitmapIndex::full(9);
    Bits expected_full(9, true);
    check_bitmap(full, expected_full, "full constructor");
    check_bitmap(~full, Bits(9, false), "NOT full");

    const std::vector<BitmapIndex::Run> raw_runs{
        {15, 25}, {0, 5}, {3, 9}, {8, 12}, {12, 13}, {20, 20}};
    const BitmapIndex normalized =
        BitmapIndex::from_runs(raw_runs, 20);
    Bits expected(20, false);
    std::fill(expected.begin(), expected.begin() + 13, true);
    std::fill(expected.begin() + 15, expected.end(), true);
    check_bitmap(normalized, expected, "merged and clipped input runs");

    const std::vector<unsigned> indices{5, 1, 2, 2, 4, 8, 7};
    const BitmapIndex indexed =
        BitmapIndex::from_indices(indices, 10);
    const Bits indexed_expected{false, true,  true,  false, true, true,
                                false, true,  true,  false};
    check_bitmap(indexed, indexed_expected, "sorted unique indices");
    require(indexed.run_count() == 3,
            "adjacent indices must be compressed into one run");

    const BitmapIndex inferred = BitmapIndex::from_indices(indices);
    require(inferred.universe_size() == 9,
            "inferred universe must cover the largest index");
    check_bitmap(inferred, Bits{false, true, true, false, true, true,
                               false, true, true},
                 "inferred universe");
}

void test_all_pairs_exhaustive() {
    for (std::size_t universe_size = 0; universe_size <= 6;
         ++universe_size) {
        const std::uint64_t limit =
            std::uint64_t{1} << universe_size;
        for (std::uint64_t left_mask = 0; left_mask < limit;
             ++left_mask) {
            const Bits left_bits = decode_mask(universe_size, left_mask);
            const BitmapIndex left = BitmapIndex(left_bits);
            const std::string left_context =
                "left mask " + std::to_string(left_mask) + " in universe " +
                std::to_string(universe_size);
            check_bitmap(left, left_bits, "left " + left_context);
            check_bitmap(~left, bit_not(left_bits), "NOT " + left_context);

            for (std::uint64_t right_mask = 0; right_mask < limit;
                 ++right_mask) {
                const Bits right_bits =
                    decode_mask(universe_size, right_mask);
                const BitmapIndex right(right_bits);
                const std::string context =
                    "masks " + std::to_string(left_mask) + "/" +
                    std::to_string(right_mask) + " in universe " +
                    std::to_string(universe_size);

                check_bitmap(left & right, bit_and(left_bits, right_bits),
                             "AND " + context);
                check_bitmap(left | right, bit_or(left_bits, right_bits),
                             "OR " + context);
                check_bitmap(left - right,
                             bit_and_not(left_bits, right_bits),
                             "AND-NOT " + context);
                check_bitmap(left ^ right, bit_xor(left_bits, right_bits),
                             "XOR " + context);
            }
        }
    }
}

void test_predicate_identities_exhaustive() {
    constexpr std::size_t universe_size = 4;
    constexpr std::uint64_t limit = std::uint64_t{1} << universe_size;

    for (std::uint64_t a = 0; a < limit; ++a) {
        for (std::uint64_t b = 0; b < limit; ++b) {
            for (std::uint64_t c = 0; c < limit; ++c) {
                const Bits left_bits = decode_mask(universe_size, a);
                const Bits middle_bits = decode_mask(universe_size, b);
                const Bits right_bits = decode_mask(universe_size, c);
                const BitmapIndex left(left_bits);
                const BitmapIndex middle(middle_bits);
                const BitmapIndex right(right_bits);
                const std::string context =
                    "predicates " + std::to_string(a) + "/" +
                    std::to_string(b) + "/" + std::to_string(c);

                check_bitmap(
                    (left & middle) | (left & ~middle), left_bits,
                    "split predicate " + context);
                check_bitmap(~(left | middle),
                             bit_not(bit_or(left_bits, middle_bits)),
                             "De Morgan OR " + context);
                check_bitmap(~(left & middle),
                             bit_not(bit_and(left_bits, middle_bits)),
                             "De Morgan AND " + context);
                check_bitmap(left - middle,
                             bit_and_not(left_bits, middle_bits),
                             "difference predicate " + context);
                check_bitmap(left ^ middle,
                             bit_xor(left_bits, middle_bits),
                             "XOR predicate " + context);
                check_bitmap((left & middle) | (left & right),
                             bit_and(left_bits,
                                     bit_or(middle_bits, right_bits)),
                             "distributive AND " + context);
                check_bitmap(left | (middle & right),
                             bit_or(left_bits,
                                    bit_and(middle_bits, right_bits)),
                             "distributive OR " + context);
            }
        }
    }
}

void test_single_run_boundaries() {
    constexpr std::size_t universe_size = 17;
    for (std::size_t left_begin = 0; left_begin <= universe_size;
         ++left_begin) {
        for (std::size_t left_end = left_begin;
             left_end <= universe_size; ++left_end) {
            const std::vector<BitmapIndex::Run> left_runs{
                {left_begin, left_end}};
            const BitmapIndex left =
                BitmapIndex::from_runs(left_runs, universe_size);
            Bits left_bits(universe_size, false);
            std::fill(left_bits.begin() +
                          static_cast<std::ptrdiff_t>(left_begin),
                      left_bits.begin() +
                          static_cast<std::ptrdiff_t>(left_end),
                      true);

            for (std::size_t right_begin = 0;
                 right_begin <= universe_size; ++right_begin) {
                for (std::size_t right_end = right_begin;
                     right_end <= universe_size; ++right_end) {
                    const std::vector<BitmapIndex::Run> right_runs{
                        {right_begin, right_end}};
                    const BitmapIndex right =
                        BitmapIndex::from_runs(right_runs, universe_size);
                    Bits right_bits(universe_size, false);
                    std::fill(
                        right_bits.begin() +
                            static_cast<std::ptrdiff_t>(right_begin),
                        right_bits.begin() +
                            static_cast<std::ptrdiff_t>(right_end),
                        true);

                    std::ostringstream context;
                    context << "runs [" << left_begin << ',' << left_end
                            << ") and [" << right_begin << ','
                            << right_end << ')';
                    check_bitmap(left & right,
                                 bit_and(left_bits, right_bits),
                                 "boundary AND " + context.str());
                    check_bitmap(left | right,
                                 bit_or(left_bits, right_bits),
                                 "boundary OR " + context.str());
                    check_bitmap(left - right,
                                 bit_and_not(left_bits, right_bits),
                                 "boundary AND-NOT " + context.str());
                }
            }
        }
    }
}

void test_interleaved_mutation_and_compression() {
    constexpr std::size_t universe_size = 211;
    constexpr std::size_t steps = 600;

    std::mt19937_64 random(0x5EEDB17ULL);
    BitmapIndex actual(universe_size);
    Bits expected(universe_size, false);

    auto random_position = [&]() {
        return static_cast<std::size_t>(random() % universe_size);
    };
    auto ordered_range = [&]() {
        std::size_t first = random_position();
        std::size_t last = random_position();
        if (first > last) {
            std::swap(first, last);
        }
        if (first == last && last + 1 <= universe_size) {
            ++last;
        }
        return std::pair{first, last};
    };

    for (std::size_t step = 0; step < steps; ++step) {
        const auto [first, last] = ordered_range();
        switch (random() % 8U) {
            case 0:
                actual.set_range(first, last);
                std::fill(expected.begin() +
                              static_cast<std::ptrdiff_t>(first),
                          expected.begin() +
                              static_cast<std::ptrdiff_t>(last),
                          true);
                break;
            case 1:
                actual.reset_range(first, last);
                std::fill(expected.begin() +
                              static_cast<std::ptrdiff_t>(first),
                          expected.begin() +
                              static_cast<std::ptrdiff_t>(last),
                          false);
                break;
            case 2:
                actual.flip_range(first, last);
                for (std::size_t index = first; index < last; ++index) {
                    expected[index] = !expected[index];
                }
                break;
            case 3:
                actual.flip();
                expected = bit_not(expected);
                break;
            default: {
                Bits operand_bits(universe_size, false);
                const std::size_t run_total =
                    1 + static_cast<std::size_t>(random() % 8);
                for (std::size_t run_index = 0; run_index < run_total;
                     ++run_index) {
                    const auto [run_begin, run_end] = ordered_range();
                    std::fill(
                        operand_bits.begin() +
                            static_cast<std::ptrdiff_t>(run_begin),
                        operand_bits.begin() +
                            static_cast<std::ptrdiff_t>(run_end),
                        true);
                }
                const BitmapIndex operand(operand_bits);
                switch (random() % 4U) {
                    case 0:
                        actual &= operand;
                        expected = bit_and(expected, operand_bits);
                        break;
                    case 1:
                        actual |= operand;
                        expected = bit_or(expected, operand_bits);
                        break;
                    case 2:
                        actual -= operand;
                        expected = bit_and_not(expected, operand_bits);
                        break;
                    default:
                        actual ^= operand;
                        expected = bit_xor(expected, operand_bits);
                        break;
                }
                break;
            }
        }

        check_bitmap(actual, expected,
                     "interleaved step " + std::to_string(step));
        if (actual.run_count() > actual.cardinality() + 1) {
            fail("run representation was not compressed after step " +
                 std::to_string(step));
        }
    }
}

void test_resize_and_errors() {
    const BitmapIndex original = from_mask(12, 0b101101001011ULL);
    BitmapIndex resized = original;
    resized.resize(7);
    check_bitmap(resized, Bits{true, true, false, true, false, false, true},
                 "shrink resize");
    resized.resize(10);
    check_bitmap(resized,
                 Bits{true, true, false, true, false, false, true, false,
                      false, false},
                 "grow resize");

    const BitmapIndex other(11);
    bool mismatched_universe_threw = false;
    try {
        static_cast<void>(original & other);
    } catch (const std::invalid_argument&) {
        mismatched_universe_threw = true;
    }
    require(mismatched_universe_threw,
            "binary operations must reject different universes");

    bool bad_range_threw = false;
    try {
        BitmapIndex bad(4);
        bad.set_range(3, 2);
    } catch (const std::invalid_argument&) {
        bad_range_threw = true;
    }
    require(bad_range_threw, "reversed range must be rejected");

    bool outside_universe_threw = false;
    try {
        const std::vector<int> indices{-1};
        static_cast<void>(BitmapIndex::from_indices(indices, 4));
    } catch (const std::out_of_range&) {
        outside_universe_threw = true;
    }
    require(outside_universe_threw, "negative index must be rejected");
}

}  // namespace

int main() {
    try {
        test_empty_and_boundaries();
        test_all_pairs_exhaustive();
        test_predicate_identities_exhaustive();
        test_single_run_boundaries();
        test_interleaved_mutation_and_compression();
        test_resize_and_errors();
    } catch (const std::exception& error) {
        std::cerr << "bitmap index test failed: " << error.what() << '\n';
        return 1;
    }

    std::cout << "bitmap index tests passed\n";
    return 0;
}
