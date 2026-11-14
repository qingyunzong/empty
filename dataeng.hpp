#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <iosfwd>
#include <span>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

// Exact timestamp arithmetic uses 128-bit integers.  All supported timestamp
// resolutions fit in 64 bits and all accepted timestamp/offset combinations fit
// in a signed 128-bit numerator (see TimestampResolution::is_supported()).
namespace dataeng {

using wide_int = __int128_t;
using uwide_int = unsigned __int128;

enum class ByteOrder {
    little_endian,
    big_endian,
};

enum class TimestampBase {
    decimal,
    binary,
};

class PcapNgError : public std::runtime_error {
public:
    explicit PcapNgError(std::string message);
    PcapNgError(std::string message, std::uint64_t byte_offset);

    // Offset of the block (or option) that caused the error.  Zero is a valid
    // file offset, so use has_byte_offset() to distinguish it from "unknown".
    std::uint64_t byte_offset() const noexcept { return byte_offset_; }
    bool has_byte_offset() const noexcept { return has_byte_offset_; }

private:
    std::uint64_t byte_offset_ = 0;
    bool has_byte_offset_ = false;
};

// An option is kept verbatim, including the padding bytes that follow its
// value.  Unknown option codes are therefore lossless: value contains exactly
// the option length bytes and padding contains the 0-3 alignment bytes.
struct PcapNgOption {
    std::uint16_t code = 0;
    std::vector<std::uint8_t> value;
    std::array<std::uint8_t, 3> padding{};

    bool operator==(const PcapNgOption&) const = default;
};

using Option = PcapNgOption;

// A reduced rational number.  The denominator is always positive.  No floating
// point is used by any normalization or ordering operation.
class Rational {
public:
    Rational() noexcept = default;
    Rational(wide_int numerator, std::uint64_t denominator = 1);

    wide_int numerator() const noexcept { return numerator_; }
    std::uint64_t denominator() const noexcept { return denominator_; }
    std::pair<wide_int, std::uint64_t> parts() const noexcept {
        return {numerator_, denominator_};
    }

    int compare(const Rational& other) const noexcept;
    bool operator==(const Rational& other) const noexcept {
        return compare(other) == 0;
    }
    bool operator!=(const Rational& other) const noexcept {
        return compare(other) != 0;
    }
    bool operator<(const Rational& other) const noexcept {
        return compare(other) < 0;
    }
    bool operator<=(const Rational& other) const noexcept {
        return compare(other) <= 0;
    }
    bool operator>(const Rational& other) const noexcept {
        return compare(other) > 0;
    }
    bool operator>=(const Rational& other) const noexcept {
        return compare(other) >= 0;
    }

    double to_double() const noexcept;
    std::string to_string() const;

private:
    wide_int numerator_ = 0;
    std::uint64_t denominator_ = 1;
};

// Tick duration is base^-exponent seconds.  The pcapng default is 10^-6.
struct TimestampResolution {
    TimestampBase base = TimestampBase::decimal;
    std::uint8_t exponent = 6;

    // Number of ticks per second.  Returns zero for unsupported resolutions.
    std::uint64_t units_per_second() const noexcept;

    // Alias used by code that describes the value as a denominator.
    std::uint64_t denominator() const noexcept { return units_per_second(); }

    bool is_binary() const noexcept { return base == TimestampBase::binary; }
    bool is_supported() const noexcept { return units_per_second() != 0; }

    Rational tick_duration() const;

    static TimestampResolution from_tsresol(std::uint8_t value) noexcept;
    static bool is_supported(TimestampBase base,
                             std::uint8_t exponent) noexcept;

    bool operator==(const TimestampResolution&) const = default;
};

// The half-open interval represented by one recorded tick: [lower, upper).
// It makes the timestamp quantization explicit without discarding the exact
// recorded value.
struct TimestampInterval {
    Rational lower;
    Rational upper;

    bool operator==(const TimestampInterval&) const = default;
};

// A pcapng timestamp in its original interface tick domain together with the
// exact normalized time.  raw_ticks(), resolution(), and offset_seconds() keep
// the capture-side precision information intact; time() is an exact rational
// number of seconds since the Unix epoch.
class Timestamp {
public:
    Timestamp() noexcept = default;
    Timestamp(std::uint64_t raw_ticks,
              TimestampResolution resolution,
              std::int64_t offset_seconds = 0);

    std::uint64_t raw_ticks() const noexcept { return raw_ticks_; }
    std::int64_t offset_seconds() const noexcept { return offset_seconds_; }
    const TimestampResolution& resolution() const noexcept {
        return resolution_;
    }
    std::uint64_t units_per_second() const noexcept {
        return resolution_.units_per_second();
    }

    // Exact numerator over the interface's ticks-per-second denominator.  The
    // result may be negative for times before the Unix epoch.
    wide_int numerator() const noexcept { return scaled_ticks_; }
    std::uint64_t denominator() const noexcept { return units_per_second(); }

    // Reduced exact seconds since the Unix epoch.
    Rational time() const;
    Rational seconds() const { return time(); }

    // Duration of one tick (the timestamp quantization), in seconds.
    Rational quantum() const { return resolution_.tick_duration(); }
    TimestampInterval uncertainty_interval() const;

    int compare(const Timestamp& other) const noexcept;
    bool operator==(const Timestamp& other) const noexcept {
        return compare(other) == 0;
    }
    bool operator!=(const Timestamp& other) const noexcept {
        return compare(other) != 0;
    }
    bool operator<(const Timestamp& other) const noexcept {
        return compare(other) < 0;
    }
    bool operator<=(const Timestamp& other) const noexcept {
        return compare(other) <= 0;
    }
    bool operator>(const Timestamp& other) const noexcept {
        return compare(other) > 0;
    }
    bool operator>=(const Timestamp& other) const noexcept {
        return compare(other) >= 0;
    }

    // Convenience only.  Ordering never uses this conversion.
    double seconds_approx() const noexcept;
    std::string to_string() const;

private:
    void update_scaled_ticks() noexcept;

    std::uint64_t raw_ticks_ = 0;
    TimestampResolution resolution_{};
    std::int64_t offset_seconds_ = 0;
    wide_int scaled_ticks_ = 0;
};

struct SectionHeader {
    std::uint32_t index = 0;
    ByteOrder byte_order = ByteOrder::little_endian;
    std::uint16_t major_version = 0;
    std::uint16_t minor_version = 0;
    std::int64_t section_length = -1;
    std::vector<PcapNgOption> options;
};

using SectionHeaderBlock = SectionHeader;

struct InterfaceDescription {
    // Interface ids are local to their section and start at zero.
    std::uint32_t id = 0;
    std::uint16_t link_type = 0;
    std::uint16_t reserved = 0;
    std::uint32_t snap_length = 0;
    TimestampResolution time_resolution{};
    std::int64_t time_offset_seconds = 0;
    std::vector<PcapNgOption> options;
};

using Interface = InterfaceDescription;
using InterfaceDescriptionBlock = InterfaceDescription;

struct Packet {
    // Global capture order in the file (zero based).
    std::uint64_t index = 0;
    std::uint32_t section_index = 0;
    std::uint32_t interface_id = 0;

    // The unmodified 64-bit tick value from the Enhanced Packet Block.
    std::uint64_t raw_timestamp = 0;
    Timestamp timestamp;

    std::uint32_t captured_length = 0;
    std::uint32_t original_length = 0;
    std::vector<std::uint8_t> data;
    std::vector<PcapNgOption> options;
};

using EnhancedPacketBlock = Packet;

struct Section {
    SectionHeader header;
    // Index in this vector is the section-local interface id.
    std::vector<InterfaceDescription> interfaces;
    std::uint64_t first_packet_index = 0;
    std::uint64_t packet_count = 0;
};

struct PcapNgDocument {
    std::vector<Section> sections;
    // Packets remain in capture order until sort_packets_by_timestamp() is
    // called.  Each packet carries its section index; interface ids must only
    // be resolved within that section.
    std::vector<Packet> packets;

    const Section* section_at(std::uint32_t section_index) const noexcept;
    Section* section_at(std::uint32_t section_index) noexcept;

    const InterfaceDescription* find_interface(
        std::uint32_t section_index,
        std::uint32_t interface_id) const noexcept;
    InterfaceDescription* find_interface(std::uint32_t section_index,
                                         std::uint32_t interface_id) noexcept;

    // Exact cross-interface/cross-section ordering.  Ties keep capture order.
    void sort_packets_by_timestamp();
    std::vector<Packet> sorted_packets() const;
};

using PcapNg = PcapNgDocument;

struct ParseOptions {
    // When false, packet bytes are not copied but captured_length is retained.
    bool keep_packet_data = true;
};

class PcapNgParser {
public:
    explicit PcapNgParser(ParseOptions options = {});

    PcapNgDocument parse(std::span<const std::uint8_t> bytes) const;
    PcapNgDocument parse(const std::uint8_t* data, std::size_t size) const;
    PcapNgDocument parse(std::istream& stream) const;
    PcapNgDocument parse_file(const std::string& path) const;

    const ParseOptions& options() const noexcept { return options_; }

private:
    ParseOptions options_;
};

using PcapNgReader = PcapNgParser;

PcapNgDocument parse_pcapng(std::span<const std::uint8_t> bytes,
                            ParseOptions options = {});
PcapNgDocument parse_pcapng(const std::uint8_t* data,
                            std::size_t size,
                            ParseOptions options = {});
PcapNgDocument parse_pcapng(std::istream& stream,
                            ParseOptions options = {});
PcapNgDocument parse_pcapng_file(const std::string& path,
                                 ParseOptions options = {});

inline PcapNgDocument read_pcapng(std::span<const std::uint8_t> bytes,
                                  ParseOptions options = {}) {
    return parse_pcapng(bytes, options);
}
inline PcapNgDocument read_pcapng(std::istream& stream,
                                  ParseOptions options = {}) {
    return parse_pcapng(stream, options);
}
inline PcapNgDocument read_pcapng_file(const std::string& path,
                                       ParseOptions options = {}) {
    return parse_pcapng_file(path, options);
}

// Exact-orders all packets by normalized timestamp and optionally discards
// packet bytes.  Raw ticks and per-packet resolution remain available.
std::vector<Packet> normalize_pcapng(std::span<const std::uint8_t> bytes,
                                     bool sort_by_time = true,
                                     ParseOptions options = {});
std::vector<Packet> normalize_pcapng(const std::uint8_t* data,
                                     std::size_t size,
                                     bool sort_by_time = true,
                                     ParseOptions options = {});

void sort_packets_by_timestamp(std::vector<Packet>& packets);
std::vector<std::size_t> sorted_packet_indices(const PcapNgDocument& document);

}  // namespace dataeng
