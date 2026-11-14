#include "dataeng.hpp"

#include <cstdint>
#include <cstring>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

namespace {

using dataeng::ByteOrder;
using Bytes = std::vector<std::uint8_t>;

int failures = 0;

#define CHECK(condition)                                                    \
    do {                                                                    \
        if (!(condition)) {                                                 \
            std::cerr << __FILE__ << ':' << __LINE__                        \
                      << ": CHECK failed: " #condition << '\n';             \
            ++failures;                                                     \
        }                                                                   \
    } while (false)

void put_u16(Bytes& out, std::uint16_t value, ByteOrder order) {
    if (order == ByteOrder::little_endian) {
        out.push_back(static_cast<std::uint8_t>(value));
        out.push_back(static_cast<std::uint8_t>(value >> 8));
    } else {
        out.push_back(static_cast<std::uint8_t>(value >> 8));
        out.push_back(static_cast<std::uint8_t>(value));
    }
}

void put_u32(Bytes& out, std::uint32_t value, ByteOrder order) {
    for (int index = 0; index < 4; ++index) {
        const int shift =
            order == ByteOrder::little_endian ? index * 8 : (3 - index) * 8;
        out.push_back(static_cast<std::uint8_t>(value >> shift));
    }
}

void put_u64(Bytes& out, std::uint64_t value, ByteOrder order) {
    for (int index = 0; index < 8; ++index) {
        const int shift =
            order == ByteOrder::little_endian ? index * 8 : (7 - index) * 8;
        out.push_back(static_cast<std::uint8_t>(value >> shift));
    }
}

void pad_to_four(Bytes& out) {
    while (out.size() % 4 != 0) {
        out.push_back(0);
    }
}

Bytes make_option(std::uint16_t code,
                  const Bytes& value,
                  ByteOrder order) {
    Bytes out;
    put_u16(out, code, order);
    put_u16(out, static_cast<std::uint16_t>(value.size()), order);
    out.insert(out.end(), value.begin(), value.end());
    pad_to_four(out);
    return out;
}

void append(Bytes& out, const Bytes& value) {
    out.insert(out.end(), value.begin(), value.end());
}

void append_block(Bytes& out,
                  std::uint32_t type,
                  Bytes body,
                  ByteOrder order) {
    pad_to_four(body);
    put_u32(out, type, order);
    put_u32(out, static_cast<std::uint32_t>(12 + body.size()), order);
    append(out, body);
    put_u32(out, static_cast<std::uint32_t>(12 + body.size()), order);
}

void append_shb(Bytes& out,
                ByteOrder order,
                const std::vector<Bytes>& options = {}) {
    Bytes body;
    put_u32(body, 0x1A2B3C4D, order);
    put_u16(body, 1, order);
    put_u16(body, 0, order);
    put_u64(body, 0xFFFFFFFFFFFFFFFFULL, order);
    for (const Bytes& option : options) {
        append(body, option);
    }
    append_block(out, 0x0A0D0D0A, std::move(body), order);
}

void append_idb(Bytes& out,
                ByteOrder order,
                std::uint16_t link_type,
                std::uint32_t snap_length,
                const std::vector<Bytes>& options = {}) {
    Bytes body;
    put_u16(body, link_type, order);
    put_u16(body, 0, order);
    put_u32(body, snap_length, order);
    for (const Bytes& option : options) {
        append(body, option);
    }
    append_block(out, 0x00000001, std::move(body), order);
}

void append_epb(Bytes& out,
                ByteOrder order,
                std::uint32_t interface_id,
                std::uint64_t timestamp,
                const Bytes& packet_data,
                const std::vector<Bytes>& options = {}) {
    Bytes body;
    put_u32(body, interface_id, order);
    put_u32(body, static_cast<std::uint32_t>(timestamp >> 32), order);
    put_u32(body, static_cast<std::uint32_t>(timestamp), order);
    put_u32(body, static_cast<std::uint32_t>(packet_data.size()), order);
    put_u32(body, static_cast<std::uint32_t>(packet_data.size()), order);
    append(body, packet_data);
    pad_to_four(body);
    for (const Bytes& option : options) {
        append(body, option);
    }
    append_block(out, 0x00000006, std::move(body), order);
}

bool option_equals(const dataeng::PcapNgOption& option,
                   std::uint16_t code,
                   const Bytes& value) {
    return option.code == code && option.value == value;
}

void test_multi_section_and_exact_ordering() {
    constexpr ByteOrder little = ByteOrder::little_endian;
    constexpr ByteOrder big = ByteOrder::big_endian;
    Bytes file;

    append_shb(file, little,
               {make_option(0x0BAD, {1, 2, 3, 4, 5}, little)});
    append_idb(file, little, 1, 65535,
               {make_option(0x2222, {9, 8, 7}, little)});
    append_idb(file, little, 147, 9000,
               {make_option(9, {9}, little),
                make_option(14, {2, 0, 0, 0, 0, 0, 0, 0}, little),
                make_option(0x3333, {1}, little)});
    append_epb(file, little, 1, 1'500'000'000, {1, 2, 3, 4},
               {make_option(0x4444, {0xAA, 0xBB, 0xCC}, little)});
    append_epb(file, little, 0, 4'000'000, {5, 6});

    append_shb(file, big);
    append_idb(file, big, 101, 262144,
               {make_option(9, {0x8A}, big),
                make_option(14, {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
                                 0xFF},
                            big)});
    append_epb(file, big, 0, 3072, {}, {make_option(0x5555, {7, 8}, big)});

    const dataeng::PcapNgDocument document = dataeng::parse_pcapng(file);
    CHECK(document.sections.size() == 2);
    CHECK(document.packets.size() == 3);
    CHECK(document.sections[0].header.byte_order == little);
    CHECK(document.sections[1].header.byte_order == big);
    CHECK(document.sections[0].interfaces.size() == 2);
    CHECK(document.sections[1].interfaces.size() == 1);

    // Interface numbering starts at zero again in the new section.
    CHECK(document.sections[0].interfaces[0].id == 0);
    CHECK(document.sections[0].interfaces[1].id == 1);
    CHECK(document.sections[1].interfaces[0].id == 0);
    CHECK(document.find_interface(1, 0) != nullptr);
    CHECK(document.find_interface(1, 1) == nullptr);

    CHECK(document.sections[0].header.options.size() == 1);
    CHECK(option_equals(document.sections[0].header.options[0], 0x0BAD,
                        {1, 2, 3, 4, 5}));
    CHECK(document.sections[0].header.options[0].padding[0] == 0);
    CHECK(document.sections[0].interfaces[1].options.size() == 3);
    CHECK(option_equals(document.sections[0].interfaces[1].options[2],
                        0x3333, {1}));

    const dataeng::Packet& first = document.packets[0];
    CHECK(first.section_index == 0);
    CHECK(first.interface_id == 1);
    CHECK(first.raw_timestamp == 1'500'000'000);
    CHECK(first.timestamp.raw_ticks() == 1'500'000'000);
    CHECK(first.timestamp.resolution().base ==
          dataeng::TimestampBase::decimal);
    CHECK(first.timestamp.resolution().exponent == 9);
    CHECK(first.timestamp.offset_seconds() == 2);
    CHECK(first.timestamp.numerator() == 3'500'000'000LL);
    CHECK(first.timestamp.denominator() == 1'000'000'000);
    CHECK(first.timestamp.time() == dataeng::Rational(7, 2));
    CHECK(first.timestamp.quantum() ==
          dataeng::Rational(1, 1'000'000'000));
    const dataeng::TimestampInterval expected_interval{
        dataeng::Rational(7, 2),
        dataeng::Rational(3'500'000'001LL, 1'000'000'000)};
    CHECK(first.timestamp.uncertainty_interval() == expected_interval);
    CHECK(first.captured_length == 4);
    CHECK(first.original_length == 4);
    CHECK(first.data == Bytes({1, 2, 3, 4}));
    CHECK(first.options.size() == 1);
    CHECK(option_equals(first.options[0], 0x4444, {0xAA, 0xBB, 0xCC}));
    CHECK(first.options[0].padding[0] == 0);

    const dataeng::Packet& second = document.packets[1];
    CHECK(second.section_index == 0);
    CHECK(second.interface_id == 0);
    CHECK(second.timestamp.resolution() == dataeng::TimestampResolution{});
    CHECK(second.timestamp.time() == dataeng::Rational(4));
    CHECK(second.timestamp.raw_ticks() == 4'000'000);

    const dataeng::Packet& third = document.packets[2];
    CHECK(third.section_index == 1);
    CHECK(third.interface_id == 0);
    CHECK(third.raw_timestamp == 3072);
    CHECK(third.timestamp.raw_ticks() == 3072);
    CHECK(third.timestamp.resolution().base ==
          dataeng::TimestampBase::binary);
    CHECK(third.timestamp.resolution().exponent == 10);
    CHECK(third.timestamp.units_per_second() == 1024);
    CHECK(third.timestamp.offset_seconds() == -1);
    CHECK(third.timestamp.numerator() == 2048);
    CHECK(third.timestamp.time() == dataeng::Rational(2));
    CHECK(third.options.size() == 1);
    CHECK(option_equals(third.options[0], 0x5555, {7, 8}));

    CHECK(document.sections[0].packet_count == 2);
    CHECK(document.sections[1].packet_count == 1);

    const std::vector<std::size_t> order =
        dataeng::sorted_packet_indices(document);
    CHECK(order == std::vector<std::size_t>({2, 0, 1}));

    const std::vector<dataeng::Packet> sorted = document.sorted_packets();
    CHECK(sorted.size() == 3);
    CHECK(sorted[0].raw_timestamp == 3072);
    CHECK(sorted[0].timestamp.resolution().exponent == 10);
    CHECK(sorted[1].raw_timestamp == 1'500'000'000);
    CHECK(sorted[1].timestamp.offset_seconds() == 2);
    CHECK(sorted[2].raw_timestamp == 4'000'000);

    dataeng::PcapNgDocument copy = document;
    copy.sort_packets_by_timestamp();
    CHECK(copy.packets[0].section_index == 1);
    CHECK(copy.packets[1].section_index == 0);
    CHECK(copy.packets[2].section_index == 0);
}

void test_large_ticks_binary_and_negative_times() {
    constexpr ByteOrder little = ByteOrder::little_endian;
    constexpr std::uint64_t large_ticks = 0x123456789ABCDEF0ULL;
    Bytes file;

    append_shb(file, little);
    append_idb(file, little, 1, 65535,
               {make_option(9, {0x8A}, little)});  // 2^-10 seconds.
    append_idb(file, little, 1, 65535,
               {make_option(9, {9}, little),
                make_option(14, {0xF6, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
                                 0xFF},
                            little)});  // -10 seconds.
    append_epb(file, little, 0, large_ticks, {});
    append_epb(file, little, 1, 0, {});

    const dataeng::PcapNgDocument document = dataeng::parse_pcapng(file);
    CHECK(document.packets.size() == 2);
    const dataeng::Timestamp& binary = document.packets[0].timestamp;
    CHECK(binary.raw_ticks() == large_ticks);
    CHECK(binary.numerator() ==
          static_cast<dataeng::wide_int>(large_ticks));
    CHECK(binary.denominator() == 1024);
    CHECK(binary.time() == dataeng::Rational(
                               static_cast<dataeng::wide_int>(large_ticks),
                               1024));

    const dataeng::Timestamp& negative = document.packets[1].timestamp;
    CHECK(negative.raw_ticks() == 0);
    CHECK(negative.numerator() == -10'000'000'000LL);
    CHECK(negative.time() == dataeng::Rational(-10));
    CHECK(negative < binary);
    CHECK(dataeng::sorted_packet_indices(document) ==
          std::vector<std::size_t>({1, 0}));
}

void test_equal_times_keep_capture_order() {
    constexpr ByteOrder little = ByteOrder::little_endian;
    Bytes file;

    append_shb(file, little);
    append_idb(file, little, 1, 65535);  // Default 10^-6.
    append_idb(file, little, 1, 65535,
               {make_option(9, {0x8A}, little)});  // 2^-10.
    append_epb(file, little, 0, 1'000'000, {});
    append_epb(file, little, 1, 1024, {});

    const dataeng::PcapNgDocument document = dataeng::parse_pcapng(file);
    CHECK(document.packets[0].timestamp.time() == dataeng::Rational(1));
    CHECK(document.packets[1].timestamp.time() == dataeng::Rational(1));
    CHECK(document.packets[0].timestamp == document.packets[1].timestamp);

    const std::vector<dataeng::Packet> sorted = document.sorted_packets();
    CHECK(sorted[0].interface_id == 0);
    CHECK(sorted[1].interface_id == 1);
}

void test_big_endian_scalars() {
    constexpr ByteOrder big = ByteOrder::big_endian;
    constexpr std::uint64_t offset_seconds = 0x0102030405060708ULL;
    constexpr std::uint64_t raw_ticks = 0x0000000100000002ULL;
    Bytes file;

    append_shb(file, big);
    append_idb(file, big, 1, 65535,
               {make_option(9, {0x8C}, big),  // 2^-12 seconds.
                make_option(14, {1, 2, 3, 4, 5, 6, 7, 8}, big)});
    append_epb(file, big, 0, raw_ticks, {0xDE, 0xAD, 0xBE});

    const dataeng::PcapNgDocument document = dataeng::parse_pcapng(file);
    CHECK(document.packets.size() == 1);
    const dataeng::Packet& packet = document.packets[0];
    CHECK(packet.raw_timestamp == raw_ticks);
    CHECK(packet.timestamp.raw_ticks() == raw_ticks);
    CHECK(packet.timestamp.units_per_second() == 4096);
    CHECK(packet.timestamp.offset_seconds() ==
          static_cast<std::int64_t>(offset_seconds));

    const dataeng::wide_int expected =
        static_cast<dataeng::wide_int>(raw_ticks) +
        static_cast<dataeng::wide_int>(offset_seconds) * 4096;
    CHECK(packet.timestamp.numerator() == expected);
    CHECK(packet.timestamp.time() ==
          dataeng::Rational(expected, 4096));
    CHECK(packet.data == Bytes({0xDE, 0xAD, 0xBE}));
    CHECK(packet.captured_length == 3);
}

void test_stream_and_data_elision() {
    constexpr ByteOrder little = ByteOrder::little_endian;
    Bytes file;
    append_shb(file, little);
    append_idb(file, little, 1, 65535);
    append_epb(file, little, 0, 42, {1, 2, 3});
    append_block(file, 0x12345678, {9, 9}, little);
    append_epb(file, little, 0, 43, {4});

    const std::string text(reinterpret_cast<const char*>(file.data()),
                           file.size());
    std::istringstream stream(text);
    const dataeng::PcapNgDocument document =
        dataeng::parse_pcapng(stream);
    CHECK(document.packets.size() == 2);
    CHECK(document.packets[1].raw_timestamp == 43);

    dataeng::ParseOptions options;
    options.keep_packet_data = false;
    const std::vector<dataeng::Packet> normalized =
        dataeng::normalize_pcapng(file, true, options);
    CHECK(normalized.size() == 2);
    CHECK(normalized[0].captured_length == 3);
    CHECK(normalized[0].data.empty());
    CHECK(normalized[0].raw_timestamp == 42);
    CHECK(normalized[1].raw_timestamp == 43);
}

void test_malformed_inputs() {
    auto rejected = [](const Bytes& bytes) {
        try {
            (void)dataeng::parse_pcapng(bytes);
            return false;
        } catch (const dataeng::PcapNgError&) {
            return true;
        }
    };

    CHECK(rejected({}));

    {
        Bytes file;
        append_shb(file, ByteOrder::little_endian);
        file.pop_back();
        CHECK(rejected(file));
    }

    {
        Bytes file;
        append_shb(file, ByteOrder::little_endian);
        for (int index = 0; index < 4; ++index) {
            file.push_back(0);
        }
        CHECK(rejected(file));
    }

    {
        Bytes file;
        append_shb(file, ByteOrder::little_endian);
        file[8] = 0;  // Corrupt byte-order magic.
        CHECK(rejected(file));
    }

    {
        Bytes file;
        append_shb(file, ByteOrder::little_endian);
        append_idb(file, ByteOrder::little_endian, 1, 65535);
        append_epb(file, ByteOrder::little_endian, 1, 1, {});
        CHECK(rejected(file));
    }

    {
        Bytes file;
        append_shb(file, ByteOrder::little_endian);
        append_idb(file, ByteOrder::little_endian, 1, 65535,
                   {make_option(9, {1, 2}, ByteOrder::little_endian)});
        CHECK(rejected(file));
    }

    {
        Bytes file;
        append_shb(file, ByteOrder::little_endian);
        append_idb(file, ByteOrder::little_endian, 1, 65535);
        append_epb(file, ByteOrder::little_endian, 0, 1, {});
        const std::uint32_t wrong_total =
            static_cast<std::uint32_t>(file.size() - 4);
        std::memcpy(file.data() + file.size() - 4, &wrong_total, 4);
        CHECK(rejected(file));
    }
}

}  // namespace

int main() {
    test_multi_section_and_exact_ordering();
    test_large_ticks_binary_and_negative_times();
    test_equal_times_keep_capture_order();
    test_big_endian_scalars();
    test_stream_and_data_elision();
    test_malformed_inputs();

    if (failures != 0) {
        std::cerr << failures << " test(s) failed\n";
        return 1;
    }
    std::cout << "all dataeng tests passed\n";
    return 0;
}
