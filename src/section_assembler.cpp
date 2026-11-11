#include "mpegts/section_assembler.hpp"

#include <algorithm>
#include <cstring>
#include <utility>

namespace mpegts {

namespace {

constexpr uint8_t TS_SYNC_BYTE = 0x47;
constexpr uint8_t PAYLOAD_ONLY = 0x1;
constexpr uint8_t ADAPTATION_AND_PAYLOAD = 0x3;
constexpr uint8_t ADAPTATION_ONLY = 0x2;

uint16_t read16(const uint8_t* p) {
    return static_cast<uint16_t>((static_cast<uint16_t>(p[0]) << 8) | p[1]);
}

} // namespace

uint32_t crc32_mpeg2(const uint8_t* data, std::size_t length) {
    uint32_t crc = 0xFFFFFFFFu;
    for (std::size_t i = 0; i < length; ++i) {
        crc ^= static_cast<uint32_t>(data[i]) << 24;
        for (int bit = 0; bit < 8; ++bit) {
            constexpr uint32_t poly = 0x04C11DB7u;
            if (crc & 0x80000000u) {
                crc = (crc << 1) ^ poly;
            } else {
                crc <<= 1;
            }
        }
    }
    return crc;
}

SectionAssembler::SectionAssembler(uint16_t pid, PublishCallback on_publish)
    : pid_(pid), on_publish_(std::move(on_publish)) {}

void SectionAssembler::resetPending(PidState& state) {
    state.reassembly.clear();
}

void SectionAssembler::feed(const uint8_t* packet, std::size_t length) {
    if (length != TS_PACKET_SIZE || packet == nullptr || packet[0] != TS_SYNC_BYTE) {
        ++stats_.packets_ignored;
        return;
    }

    const bool transport_error = (packet[1] & 0x80) != 0;
    const bool pusi = (packet[1] & 0x40) != 0;
    const uint16_t packet_pid =
        static_cast<uint16_t>(((static_cast<uint16_t>(packet[1]) & 0x1F) << 8) |
                              packet[2]);
    const uint8_t scrambling = (packet[3] >> 6) & 0x03;
    const uint8_t adaptation_control = (packet[3] >> 4) & 0x03;
    const uint8_t cc = packet[3] & 0x0F;

    if (transport_error || scrambling != 0 || packet_pid != pid_) {
        ++stats_.packets_ignored;
        return;
    }

    ++stats_.packets_total;

    std::size_t offset = 4;
    bool discontinuity = false;
    if (adaptation_control == ADAPTATION_ONLY ||
        adaptation_control == ADAPTATION_AND_PAYLOAD) {
        const uint8_t adaptation_length = packet[offset];
        if (adaptation_length >= TS_PACKET_SIZE - offset) {
            ++stats_.packets_ignored;
            return;
        }
        if (adaptation_length > 0) {
            discontinuity = (packet[offset + 1] & 0x80) != 0;
        }
        offset += 1u + adaptation_length;
    }

    if (discontinuity) {
        ++stats_.discontinuities;
        resetPending(state_);
        state_.have_cc = false; // CC re-synchronizes after a discontinuity
    }

    const bool has_payload = adaptation_control == PAYLOAD_ONLY ||
                             adaptation_control == ADAPTATION_AND_PAYLOAD;

    // Adaptation-only packets repeat the previous CC without payload, so they
    // participate neither in duplicate detection nor in gap detection.
    if (state_.have_cc && has_payload) {
        if (state_.last_was_adaptation_only) {
            // The next payload packet legitimately reuses the CC.
            state_.last_was_adaptation_only = false;
        } else {
            const uint8_t expected =
                static_cast<uint8_t>((state_.continuity_counter + 1) & 0x0F);
            if (cc == state_.continuity_counter) {
                const std::vector<uint8_t> this_payload(packet + offset,
                                                        packet + TS_PACKET_SIZE);
                if (this_payload == state_.last_payload) {
                    ++stats_.packets_duplicate;
                    return; // identical retransmission: ignore
                }
                // Same CC but different payload is illegal: reset this PID.
                ++stats_.discontinuities;
                resetPending(state_);
                return;
            }
            if (cc != expected) {
                ++stats_.discontinuities;
                resetPending(state_);
            }
        }
    }

    state_.continuity_counter = cc;
    state_.have_cc = true;

    if (!has_payload || offset >= TS_PACKET_SIZE) {
        state_.last_was_adaptation_only = true;
        return;
    }
    state_.last_was_adaptation_only = false;

    state_.last_payload.assign(packet + offset, packet + TS_PACKET_SIZE);
    handlePayload(state_, packet + offset, TS_PACKET_SIZE - offset, pusi);
}

void SectionAssembler::handlePayload(PidState& state, const uint8_t* payload,
                                     std::size_t size, bool pusi) {
    std::size_t pos = 0;
    if (pusi) {
        // pointer_field: the next pointer_field bytes finish the previous
        // section; the new section starts right after them.
        const uint8_t pointer_field = payload[0];
        pos = 1;
        if (pointer_field >= size) {
            resetPending(state);
            return;
        }
        if (pointer_field > 0) {
            if (!state.reassembly.empty()) {
                state.reassembly.insert(state.reassembly.end(), payload + pos,
                                        payload + pos + pointer_field);
                extractFrames(state);
            }
            pos += pointer_field;
        } else if (!state.reassembly.empty()) {
            // pointer_field == 0 starts a new section immediately; pending
            // bytes can no longer form a valid frame.
            resetPending(state);
        }
    }

    if (pos >= size) {
        return;
    }

    if (!pusi) {
        if (state.reassembly.empty()) {
            return; // continuation with no known start: the start was lost
        }
        state.reassembly.insert(state.reassembly.end(), payload + pos, payload + size);
        extractFrames(state);
        return;
    }

    state.reassembly.insert(state.reassembly.end(), payload + pos, payload + size);
    extractFrames(state);
}

void SectionAssembler::extractFrames(PidState& state) {
    std::size_t consumed = 0;
    while (true) {
        const std::size_t available = state.reassembly.size() - consumed;
        if (available == 0) {
            break;
        }
        const uint8_t* p = state.reassembly.data() + consumed;
        if (p[0] == 0xFF) {
            break; // stuffing ends the usable bytes of this buffer
        }
        if (available < 3) {
            break; // section header incomplete: wait for the next packet
        }
        const uint16_t section_syntax_indicator = (p[1] >> 7) & 0x01;
        const uint16_t section_length =
            static_cast<uint16_t>(((static_cast<uint16_t>(p[1]) & 0x0F) << 8) | p[2]);
        const std::size_t frame_size = 3u + section_length;
        if (section_syntax_indicator == 0 || frame_size > MAX_SECTION_SIZE ||
            frame_size < 3u + 5u + 4u) {
            resetPending(state);
            return;
        }
        if (available < frame_size) {
            break; // section spans into following packets
        }

        std::vector<uint8_t> frame(p, p + frame_size);
        consumed += frame_size;
        handleCompleteSection(state, std::move(frame));
    }

    if (consumed > 0) {
        state.reassembly.erase(
            state.reassembly.begin(),
            state.reassembly.begin() + static_cast<std::ptrdiff_t>(consumed));
    }
}

void SectionAssembler::handleCompleteSection(PidState& state,
                                             std::vector<uint8_t> frame) {
    ++stats_.sections_completed;

    // Long sections: 3 header bytes + at least 5 fixed fields + 4 CRC bytes.
    if (frame.size() < 3u + 5u + 4u) {
        ++stats_.sections_crc_bad;
        return;
    }
    if (crc32_mpeg2(frame.data(), frame.size()) != 0) {
        ++stats_.sections_crc_bad;
        return;
    }

    const uint8_t table_id = frame[0];
    const uint16_t extension = read16(frame.data() + 3);
    const uint8_t version = (frame[5] >> 1) & 0x1F;
    const bool current_next = (frame[5] & 0x01) != 0;
    const uint8_t section_number = frame[6];
    const uint8_t last_section_number = frame[7];

    if (section_number > last_section_number) {
        ++stats_.sections_crc_bad;
        return;
    }

    Section section{table_id, extension, version, current_next, section_number,
                    last_section_number, std::move(frame)};
    const GroupKey key{table_id, extension, version};
    TableBuild* build = &groups_[key];
    build->last_section_number = last_section_number;

    auto existing = build->sections.find(section_number);
    if (existing != build->sections.end()) {
        if (existing->second.data == section.data) {
            ++stats_.sections_duplicate;
            // Identical retransmission: keep the stored slot and fall through.
        } else {
            ++stats_.sections_payload_changed;
            // Different payload at the same slot: reset this PID's in-flight
            // assembly and rebuild the affected (table_id, ext, version) group.
            resetPending(state);
            groups_.erase(key);
            build = &groups_[key];
            build->last_section_number = last_section_number;
            build->sections.emplace(section_number, std::move(section));
        }
    } else {
        build->sections.emplace(section_number, std::move(section));
    }

    if (build->sections.size() !=
        static_cast<std::size_t>(build->last_section_number) + 1) {
        return; // still waiting for the remaining sections
    }

    PublishedTable table;
    table.table_id = table_id;
    table.table_id_extension = extension;
    table.version = version;
    table.sections.reserve(build->sections.size());
    bool all_current = true;
    for (uint8_t number = 0; number <= build->last_section_number; ++number) {
        auto it = build->sections.find(number);
        if (it == build->sections.end()) {
            return; // numbering gap despite matching count: not complete
        }
        all_current = all_current && it->second.current_next;
        table.sections.push_back(it->second);
    }

    if (!all_current) {
        ++stats_.tables_cached_next; // next table: cached, never published
        return;
    }

    const CurrentKey current_key{table_id, extension};
    auto published = current_.find(current_key);
    if (published != current_.end() &&
        published->second.version == version &&
        published->second.sections.size() == table.sections.size()) {
        bool identical = true;
        for (std::size_t i = 0; i < table.sections.size(); ++i) {
            if (published->second.sections[i].data != table.sections[i].data) {
                identical = false;
                break;
            }
        }
        if (identical) {
            return; // this exact table was already atomically published
        }
    }

    current_[current_key] = table;
    ++stats_.tables_published;
    if (on_publish_) {
        on_publish_(table);
    }
}

std::optional<PublishedTable> SectionAssembler::current(
    uint8_t table_id, uint16_t table_id_extension) const {
    auto it = current_.find(CurrentKey{table_id, table_id_extension});
    if (it == current_.end()) {
        return std::nullopt;
    }
    return it->second;
}

} // namespace mpegts
