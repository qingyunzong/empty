#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <map>
#include <optional>
#include <tuple>
#include <vector>

namespace mpegts {

// One fully reassembled, CRC-valid PSI section (section bytes incl. header and CRC).
struct Section {
    uint8_t table_id = 0;
    uint16_t table_id_extension = 0;
    uint8_t version = 0;
    bool current_next = false;
    uint8_t section_number = 0;
    uint8_t last_section_number = 0;
    std::vector<uint8_t> data;
};

// A table atomically published once sections 0..last_section_number are present.
struct PublishedTable {
    uint8_t table_id = 0;
    uint16_t table_id_extension = 0;
    uint8_t version = 0;
    // Indexed by section_number; every slot holds a valid section.
    std::vector<Section> sections;
};

struct AssemblerStats {
    uint64_t packets_total = 0;
    uint64_t packets_ignored = 0;        // TEI set / scrambled / wrong size / not payload
    uint64_t packets_duplicate = 0;      // same CC, identical payload bytes
    uint64_t discontinuities = 0;        // CC gap or adaptation discontinuity flag
    uint64_t sections_completed = 0;     // length-bounded section frames finished
    uint64_t sections_crc_bad = 0;
    uint64_t sections_duplicate = 0;     // same section_number, identical payload
    uint64_t sections_payload_changed = 0; // same section_number, different payload
    uint64_t tables_cached_next = 0;     // complete but current_next == 0
    uint64_t tables_published = 0;
};

// CRC-32/MPEG-2 (poly 0x04C11DB7, init/fin 0xFFFFFFFF, no reflection, no final xor).
uint32_t crc32_mpeg2(const uint8_t* data, std::size_t length);

// Reassembles PSI sections from the MPEG-TS packets of a caller-selected PID.
//
// Feed every 188-byte packet of the configured PID via feed(). The assembler
// handles adaptation fields, continuity counters, payload_unit_start_indicator
// and pointer_field, supports sections spanning packets and multiple sections
// per packet, validates section_length and CRC-32/MPEG-2, groups fragments by
// (table_id, table_id_extension, version) and atomically publishes a table
// only when sections 0..last_section_number are all present.
class SectionAssembler {
public:
    static constexpr std::size_t TS_PACKET_SIZE = 188;
    static constexpr std::size_t MAX_SECTION_SIZE = 1024;

    using PublishCallback = std::function<void(const PublishedTable&)>;

    explicit SectionAssembler(uint16_t pid, PublishCallback on_publish = {});

    // Feeds one 188-byte packet. Packets of other PIDs are simply ignored.
    void feed(const uint8_t* packet, std::size_t length);

    // Latest current (current_next == 1) table for (table_id, extension), if any.
    std::optional<PublishedTable> current(uint8_t table_id,
                                          uint16_t table_id_extension) const;

    const AssemblerStats& stats() const noexcept { return stats_; }

private:
    using GroupKey = std::tuple<uint8_t, uint16_t, uint8_t>; // table_id, ext, version
    using CurrentKey = std::tuple<uint8_t, uint16_t>;

    struct TableBuild {
        uint8_t last_section_number = 0;
        // section_number -> section; empty data means slot not yet received
        std::map<uint8_t, Section> sections;
    };

    struct PidState {
        bool have_cc = false;
        bool last_was_adaptation_only = false;
        uint8_t continuity_counter = 0;
        std::vector<uint8_t> reassembly; // bytes of the section currently being built
        std::vector<uint8_t> last_payload; // payload of previous CC-bearing packet
    };

    void handlePayload(PidState& state, const uint8_t* payload, std::size_t size,
                       bool pusi);
    void extractFrames(PidState& state);
    void handleCompleteSection(PidState& state, std::vector<uint8_t> frame);
    void resetPending(PidState& state);

    uint16_t pid_;
    PublishCallback on_publish_;
    AssemblerStats stats_;
    PidState state_;
    std::map<GroupKey, TableBuild> groups_;
    std::map<CurrentKey, PublishedTable> current_;
};

} // namespace mpegts
