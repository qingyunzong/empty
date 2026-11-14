#include "dataeng.hpp"

#include <algorithm>
#include <bit>
#include <fstream>
#include <iterator>
#include <stdexcept>
#include <utility>

namespace dataeng {

namespace {

constexpr std::uint32_t kSectionHeaderBlockType = 0x0A0D0D0A;
constexpr std::uint32_t kInterfaceDescriptionBlockType = 0x00000001;
constexpr std::uint32_t kEnhancedPacketBlockType = 0x00000006;

constexpr std::uint16_t kOptionEndOfOpt = 0;
constexpr std::uint16_t kOptionIfTsResol = 9;
constexpr std::uint16_t kOptionIfTsOffset = 14;

constexpr std::uint32_t kByteOrderMagic = 0x1A2B3C4D;

[[noreturn]] void fail(std::string message, std::uint64_t offset) {
    message += " at byte ";
    message += std::to_string(offset);
    throw PcapNgError(std::move(message), offset);
}

std::uint16_t load_u16(const std::uint8_t* data, ByteOrder order) noexcept {
    if (order == ByteOrder::little_endian) {
        return static_cast<std::uint16_t>(data[0]) |
               static_cast<std::uint16_t>(data[1]) << 8;
    }
    return static_cast<std::uint16_t>(data[0]) << 8 |
           static_cast<std::uint16_t>(data[1]);
}

std::uint32_t load_u32(const std::uint8_t* data, ByteOrder order) noexcept {
    if (order == ByteOrder::little_endian) {
        return static_cast<std::uint32_t>(data[0]) |
               static_cast<std::uint32_t>(data[1]) << 8 |
               static_cast<std::uint32_t>(data[2]) << 16 |
               static_cast<std::uint32_t>(data[3]) << 24;
    }
    return static_cast<std::uint32_t>(data[0]) << 24 |
           static_cast<std::uint32_t>(data[1]) << 16 |
           static_cast<std::uint32_t>(data[2]) << 8 |
           static_cast<std::uint32_t>(data[3]);
}

std::uint64_t load_u64(const std::uint8_t* data, ByteOrder order) noexcept {
    const std::uint64_t high =
        order == ByteOrder::little_endian ? load_u32(data + 4, order)
                                          : load_u32(data, order);
    const std::uint64_t low =
        order == ByteOrder::little_endian ? load_u32(data, order)
                                          : load_u32(data + 4, order);
    return high << 32 | low;
}

std::uint64_t align4(std::uint64_t value) noexcept {
    return (value + 3U) & ~std::uint64_t{3};
}

uwide_int gcd_uwide(uwide_int left, uwide_int right) noexcept {
    while (right != 0) {
        const uwide_int remainder = left % right;
        left = right;
        right = remainder;
    }
    return left;
}

uwide_int magnitude(wide_int value) noexcept {
    if (value >= 0) {
        return static_cast<uwide_int>(value);
    }
    // Avoid negating the most-negative value.
    return static_cast<uwide_int>(-(value + 1)) + 1;
}

int compare_fractions(wide_int left_numerator,
                      std::uint64_t left_denominator,
                      wide_int right_numerator,
                      std::uint64_t right_denominator) noexcept {
    const wide_int left_divisor = static_cast<wide_int>(left_denominator);
    const wide_int right_divisor = static_cast<wide_int>(right_denominator);

    wide_int left_integer = left_numerator / left_divisor;
    wide_int right_integer = right_numerator / right_divisor;
    wide_int left_remainder = left_numerator % left_divisor;
    wide_int right_remainder = right_numerator % right_divisor;

    if (left_remainder < 0) {
        --left_integer;
        left_remainder += left_divisor;
    }
    if (right_remainder < 0) {
        --right_integer;
        right_remainder += right_divisor;
    }

    if (left_integer != right_integer) {
        return left_integer < right_integer ? -1 : 1;
    }

    // Both remainders are below their (64-bit) denominators, so the products
    // below fit in one unsigned 128-bit value even in the worst case.
    const uwide_int left_product =
        static_cast<uwide_int>(left_remainder) * right_denominator;
    const uwide_int right_product =
        static_cast<uwide_int>(right_remainder) * left_denominator;
    if (left_product != right_product) {
        return left_product < right_product ? -1 : 1;
    }
    return 0;
}

std::string wide_to_string(wide_int value) {
    if (value == 0) {
        return "0";
    }
    const bool negative = value < 0;
    uwide_int remaining = magnitude(value);
    std::string digits;
    while (remaining != 0) {
        digits.push_back(static_cast<char>('0' + remaining % 10));
        remaining /= 10;
    }
    if (negative) {
        digits.push_back('-');
    }
    std::reverse(digits.begin(), digits.end());
    return digits;
}

std::vector<PcapNgOption> parse_options(const std::uint8_t* data,
                                        std::size_t length,
                                        ByteOrder order,
                                        std::uint64_t area_offset) {
    std::vector<PcapNgOption> options;
    if (length % 4 != 0) {
        fail("option area length is not a multiple of four", area_offset);
    }

    std::size_t position = 0;
    while (position < length) {
        if (length - position < 4) {
            fail("truncated option header", area_offset + position);
        }
        const std::uint16_t code = load_u16(data + position, order);
        const std::uint16_t value_length =
            load_u16(data + position + 2, order);
        if (code == kOptionEndOfOpt) {
            if (value_length != 0) {
                fail("end-of-options has a non-zero length",
                     area_offset + position);
            }
            position += 4;
            for (; position < length; ++position) {
                if (data[position] != 0) {
                    fail("non-zero data after end-of-options",
                         area_offset + position);
                }
            }
            break;
        }

        const std::uint64_t padded_length = align4(value_length);
        if (padded_length > length - position - 4) {
            fail("option value extends past its block",
                 area_offset + position);
        }

        PcapNgOption option;
        option.code = code;
        option.value.assign(data + position + 4,
                            data + position + 4 + value_length);
        const std::uint64_t padding_length = padded_length - value_length;
        for (std::uint64_t index = 0; index < padding_length; ++index) {
            option.padding[index] =
                data[position + 4 + value_length + index];
        }
        options.push_back(std::move(option));
        position += 4 + static_cast<std::size_t>(padded_length);
    }
    return options;
}

void validate_block(const std::uint8_t* data,
                    std::size_t file_size,
                    std::size_t block_offset,
                    std::uint32_t total_length,
                    ByteOrder order) {
    if (total_length < 12) {
        fail("block total length is smaller than the fixed header", block_offset);
    }
    if (total_length % 4 != 0) {
        fail("block total length is not a multiple of four", block_offset);
    }
    if (total_length > file_size - block_offset) {
        fail("truncated block", block_offset);
    }
    if (load_u32(data + block_offset + total_length - 4, order) !=
        total_length) {
        fail("block total length fields do not match", block_offset);
    }
}

}  // namespace

PcapNgError::PcapNgError(std::string message)
    : std::runtime_error(std::move(message)) {}

PcapNgError::PcapNgError(std::string message, std::uint64_t byte_offset)
    : std::runtime_error(std::move(message)),
      byte_offset_(byte_offset),
      has_byte_offset_(true) {}

Rational::Rational(wide_int numerator, std::uint64_t denominator)
    : numerator_(numerator), denominator_(denominator) {
    if (denominator_ == 0) {
        throw std::invalid_argument("rational denominator must not be zero");
    }
    if (numerator_ == 0) {
        denominator_ = 1;
        return;
    }

    const uwide_int divisor = gcd_uwide(magnitude(numerator_), denominator_);
    if (divisor != 1) {
        numerator_ /= static_cast<wide_int>(divisor);
        denominator_ /= static_cast<std::uint64_t>(divisor);
    }
}

int Rational::compare(const Rational& other) const noexcept {
    return compare_fractions(numerator_, denominator_, other.numerator_,
                             other.denominator_);
}

double Rational::to_double() const noexcept {
    return static_cast<double>(numerator_) /
           static_cast<double>(denominator_);
}

std::string Rational::to_string() const {
    if (denominator_ == 1) {
        return wide_to_string(numerator_);
    }
    return wide_to_string(numerator_) + "/" +
           std::to_string(denominator_);
}

std::uint64_t TimestampResolution::units_per_second() const noexcept {
    if (base == TimestampBase::decimal) {
        static constexpr std::uint64_t powers_of_ten[] = {
            1ULL,
            10ULL,
            100ULL,
            1000ULL,
            10000ULL,
            100000ULL,
            1000000ULL,
            10000000ULL,
            100000000ULL,
            1000000000ULL,
            10000000000ULL,
            100000000000ULL,
            1000000000000ULL,
            10000000000000ULL,
            100000000000000ULL,
            1000000000000000ULL,
            10000000000000000ULL,
            100000000000000000ULL,
            1000000000000000000ULL,
            10000000000000000000ULL,
        };
        if (exponent < std::size(powers_of_ten)) {
            return powers_of_ten[exponent];
        }
        return 0;
    }
    if (exponent <= 63) {
        return std::uint64_t{1} << exponent;
    }
    return 0;
}

Rational TimestampResolution::tick_duration() const {
    const std::uint64_t units = units_per_second();
    if (units == 0) {
        throw std::invalid_argument("unsupported timestamp resolution");
    }
    return Rational(1, units);
}

TimestampResolution TimestampResolution::from_tsresol(
    std::uint8_t value) noexcept {
    TimestampResolution resolution;
    if ((value & 0x80U) != 0) {
        resolution.base = TimestampBase::binary;
    } else {
        resolution.base = TimestampBase::decimal;
    }
    resolution.exponent = static_cast<std::uint8_t>(value & 0x7FU);
    return resolution;
}

bool TimestampResolution::is_supported(TimestampBase base,
                                       std::uint8_t exponent) noexcept {
    if (base == TimestampBase::decimal) {
        return exponent <= 19;
    }
    return exponent <= 63;
}

Timestamp::Timestamp(std::uint64_t raw_ticks,
                     TimestampResolution resolution,
                     std::int64_t offset_seconds)
    : raw_ticks_(raw_ticks),
      resolution_(resolution),
      offset_seconds_(offset_seconds) {
    if (!resolution_.is_supported()) {
        throw std::invalid_argument("unsupported timestamp resolution");
    }
    update_scaled_ticks();
}

void Timestamp::update_scaled_ticks() noexcept {
    const wide_int units =
        static_cast<wide_int>(resolution_.units_per_second());
    scaled_ticks_ = static_cast<wide_int>(raw_ticks_) +
                    static_cast<wide_int>(offset_seconds_) * units;
}

Rational Timestamp::time() const {
    return Rational(scaled_ticks_, units_per_second());
}

TimestampInterval Timestamp::uncertainty_interval() const {
    const std::uint64_t units = units_per_second();
    return TimestampInterval{Rational(scaled_ticks_, units),
                             Rational(scaled_ticks_ + 1, units)};
}

int Timestamp::compare(const Timestamp& other) const noexcept {
    return compare_fractions(scaled_ticks_, units_per_second(),
                             other.scaled_ticks_, other.units_per_second());
}

double Timestamp::seconds_approx() const noexcept {
    return static_cast<double>(scaled_ticks_) /
           static_cast<double>(units_per_second());
}

std::string Timestamp::to_string() const {
    return time().to_string() + " s";
}

PcapNgParser::PcapNgParser(ParseOptions options) : options_(options) {}

PcapNgDocument PcapNgParser::parse(std::span<const std::uint8_t> bytes) const {
    PcapNgDocument document;
    const std::uint8_t* data = bytes.data();
    const std::size_t file_size = bytes.size();
    std::size_t offset = 0;
    bool have_section = false;
    ByteOrder current_order = ByteOrder::little_endian;

    while (offset < file_size) {
        if (file_size - offset < 8) {
            fail("truncated block header", offset);
        }

        const bool is_section_header =
            load_u32(data + offset, ByteOrder::little_endian) ==
            kSectionHeaderBlockType;

        if (is_section_header) {
            if (file_size - offset < 12) {
                fail("truncated section header block", offset);
            }

            const std::uint32_t magic_little =
                load_u32(data + offset + 8, ByteOrder::little_endian);
            ByteOrder section_order;
            if (magic_little == kByteOrderMagic) {
                section_order = ByteOrder::little_endian;
            } else if (magic_little == 0x4D3C2B1A) {
                section_order = ByteOrder::big_endian;
            } else {
                fail("invalid section byte-order magic", offset + 8);
            }

            const std::uint32_t total_length =
                load_u32(data + offset + 4, section_order);
            validate_block(data, file_size, offset, total_length, section_order);
            if (total_length < 28) {
                fail("section header block is too short", offset);
            }

            const std::uint8_t* body = data + offset + 8;
            const std::size_t body_length = total_length - 12;
            if (load_u32(body, section_order) != kByteOrderMagic) {
                fail("invalid byte-order magic inside section header", offset + 8);
            }

            Section section;
            section.header.index =
                static_cast<std::uint32_t>(document.sections.size());
            section.header.byte_order = section_order;
            section.header.major_version =
                load_u16(body + 4, section_order);
            section.header.minor_version =
                load_u16(body + 6, section_order);
            section.header.section_length =
                std::bit_cast<std::int64_t>(
                    load_u64(body + 8, section_order));
            section.header.options =
                parse_options(body + 16, body_length - 16, section_order,
                              offset + 24);
            section.first_packet_index = document.packets.size();
            document.sections.push_back(std::move(section));

            current_order = section_order;
            have_section = true;
            offset += total_length;
            continue;
        }

        if (!have_section) {
            fail("the first block is not a section header block", offset);
        }

        const std::uint32_t block_type = load_u32(data + offset, current_order);
        const std::uint32_t total_length =
            load_u32(data + offset + 4, current_order);
        validate_block(data, file_size, offset, total_length, current_order);

        Section& section = document.sections.back();
        const std::uint8_t* body = data + offset + 8;
        const std::size_t body_length = total_length - 12;

        if (block_type == kInterfaceDescriptionBlockType) {
            if (body_length < 8) {
                fail("interface description block is too short", offset);
            }

            InterfaceDescription interface;
            interface.id =
                static_cast<std::uint32_t>(section.interfaces.size());
            interface.link_type = load_u16(body, current_order);
            interface.reserved = load_u16(body + 2, current_order);
            interface.snap_length = load_u32(body + 4, current_order);
            interface.options =
                parse_options(body + 8, body_length - 8, current_order,
                              offset + 16);

            for (const PcapNgOption& option : interface.options) {
                if (option.code == kOptionIfTsResol) {
                    if (option.value.size() != 1) {
                        fail("if_tsresol must contain exactly one byte",
                             offset + 16);
                    }
                    interface.time_resolution =
                        TimestampResolution::from_tsresol(option.value[0]);
                    if (!interface.time_resolution.is_supported()) {
                        fail("unsupported if_tsresol value", offset + 16);
                    }
                } else if (option.code == kOptionIfTsOffset) {
                    if (option.value.size() != 8) {
                        fail("if_tsoffset must contain exactly eight bytes",
                             offset + 16);
                    }
                    interface.time_offset_seconds =
                        std::bit_cast<std::int64_t>(
                            load_u64(option.value.data(), current_order));
                }
            }

            section.interfaces.push_back(std::move(interface));
            offset += total_length;
            continue;
        }

        if (block_type == kEnhancedPacketBlockType) {
            if (body_length < 20) {
                fail("enhanced packet block is too short", offset);
            }

            const std::uint32_t interface_id =
                load_u32(body, current_order);
            const std::uint32_t timestamp_high =
                load_u32(body + 4, current_order);
            const std::uint32_t timestamp_low =
                load_u32(body + 8, current_order);
            const std::uint32_t captured_length =
                load_u32(body + 12, current_order);
            const std::uint32_t original_length =
                load_u32(body + 16, current_order);

            if (interface_id >= section.interfaces.size()) {
                fail("enhanced packet references an unknown interface",
                     offset);
            }

            const std::uint64_t padded_data_length =
                align4(captured_length);
            if (20 + padded_data_length > body_length) {
                fail("captured packet data extends past its block", offset);
            }

            const InterfaceDescription& interface =
                section.interfaces[interface_id];
            const std::uint64_t raw_timestamp =
                static_cast<std::uint64_t>(timestamp_high) << 32 |
                timestamp_low;

            Packet packet;
            packet.index = document.packets.size();
            packet.section_index = section.header.index;
            packet.interface_id = interface_id;
            packet.raw_timestamp = raw_timestamp;
            packet.timestamp =
                Timestamp(raw_timestamp, interface.time_resolution,
                          interface.time_offset_seconds);
            packet.captured_length = captured_length;
            packet.original_length = original_length;
            if (options_.keep_packet_data && captured_length != 0) {
                packet.data.assign(body + 20, body + 20 + captured_length);
            }
            packet.options =
                parse_options(body + 20 + padded_data_length,
                              static_cast<std::size_t>(body_length - 20 -
                                                       padded_data_length),
                              current_order,
                              offset + 28 + padded_data_length);

            if (section.packet_count == 0) {
                section.first_packet_index = packet.index;
            }
            ++section.packet_count;
            document.packets.push_back(std::move(packet));
            offset += total_length;
            continue;
        }

        // Unknown blocks (including Simple Packet Block and old Packet Block)
        // are skipped as a unit.  Their total length was already validated.
        offset += total_length;
    }

    if (!have_section) {
        fail("pcapng input contains no section", 0);
    }
    return document;
}

PcapNgDocument PcapNgParser::parse(std::istream& stream) const {
    std::vector<std::uint8_t> bytes{
        std::istreambuf_iterator<char>(stream),
        std::istreambuf_iterator<char>()};
    return parse(std::span<const std::uint8_t>(bytes.data(), bytes.size()));
}

PcapNgDocument PcapNgParser::parse(const std::uint8_t* data,
                                   std::size_t size) const {
    return parse(std::span<const std::uint8_t>(data, size));
}

PcapNgDocument PcapNgParser::parse_file(const std::string& path) const {
    std::ifstream stream(path, std::ios::binary);
    if (!stream) {
        throw PcapNgError("unable to open pcapng file: " + path);
    }
    return parse(stream);
}

PcapNgDocument parse_pcapng(std::span<const std::uint8_t> bytes,
                            ParseOptions options) {
    return PcapNgParser(options).parse(bytes);
}

PcapNgDocument parse_pcapng(const std::uint8_t* data,
                            std::size_t size,
                            ParseOptions options) {
    return PcapNgParser(options).parse(data, size);
}

PcapNgDocument parse_pcapng(std::istream& stream, ParseOptions options) {
    return PcapNgParser(options).parse(stream);
}

PcapNgDocument parse_pcapng_file(const std::string& path,
                                 ParseOptions options) {
    return PcapNgParser(options).parse_file(path);
}

const Section* PcapNgDocument::section_at(
    std::uint32_t section_index) const noexcept {
    if (section_index >= sections.size()) {
        return nullptr;
    }
    return &sections[section_index];
}

Section* PcapNgDocument::section_at(
    std::uint32_t section_index) noexcept {
    if (section_index >= sections.size()) {
        return nullptr;
    }
    return &sections[section_index];
}

const InterfaceDescription* PcapNgDocument::find_interface(
    std::uint32_t section_index,
    std::uint32_t interface_id) const noexcept {
    const Section* section = section_at(section_index);
    if (section == nullptr || interface_id >= section->interfaces.size()) {
        return nullptr;
    }
    return &section->interfaces[interface_id];
}

InterfaceDescription* PcapNgDocument::find_interface(
    std::uint32_t section_index,
    std::uint32_t interface_id) noexcept {
    Section* section = section_at(section_index);
    if (section == nullptr || interface_id >= section->interfaces.size()) {
        return nullptr;
    }
    return &section->interfaces[interface_id];
}

void sort_packets_by_timestamp(std::vector<Packet>& packets) {
    std::stable_sort(packets.begin(), packets.end(),
                     [](const Packet& left, const Packet& right) {
                         return left.timestamp < right.timestamp;
                     });
}

void PcapNgDocument::sort_packets_by_timestamp() {
    dataeng::sort_packets_by_timestamp(packets);
}

std::vector<Packet> PcapNgDocument::sorted_packets() const {
    std::vector<Packet> result = packets;
    dataeng::sort_packets_by_timestamp(result);
    return result;
}

std::vector<std::size_t> sorted_packet_indices(
    const PcapNgDocument& document) {
    std::vector<std::size_t> indices(document.packets.size());
    for (std::size_t index = 0; index < indices.size(); ++index) {
        indices[index] = index;
    }
    std::stable_sort(
        indices.begin(), indices.end(),
        [&document](std::size_t left, std::size_t right) {
            return document.packets[left].timestamp <
                   document.packets[right].timestamp;
        });
    return indices;
}

std::vector<Packet> normalize_pcapng(std::span<const std::uint8_t> bytes,
                                     bool sort_by_time,
                                     ParseOptions options) {
    PcapNgDocument document = parse_pcapng(bytes, options);
    if (sort_by_time) {
        document.sort_packets_by_timestamp();
    }
    return std::move(document.packets);
}

std::vector<Packet> normalize_pcapng(const std::uint8_t* data,
                                     std::size_t size,
                                     bool sort_by_time,
                                     ParseOptions options) {
    return normalize_pcapng(std::span<const std::uint8_t>(data, size),
                            sort_by_time, options);
}

}  // namespace dataeng
