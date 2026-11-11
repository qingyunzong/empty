#include "mpegts/section_assembler.hpp"

#include <cstring>
#include <iostream>
#include <vector>

using mpegts::PublishedTable;
using mpegts::SectionAssembler;
using mpegts::crc32_mpeg2;

namespace {


int g_failures = 0;
int g_checks = 0;

#define CHECK(cond)                                                             \
    do {                                                                        \
        ++g_checks;                                                             \
        if (!(cond)) {                                                          \
            ++g_failures;                                                       \
            std::cerr << "CHECK failed: " #cond                                 \
                      << " (" << __FILE__ << ":" << __LINE__ << ")\n";          \
        }                                                                       \
    } while (0)

// Builds a long-header PSI section with a valid CRC-32/MPEG-2 trailer.
std::vector<uint8_t> makeSection(uint8_t table_id, uint16_t extension,
                                 uint8_t version, bool current_next,
                                 uint8_t section_number, uint8_t last_section,
                                 std::size_t body_size, uint8_t seed = 0) {
    constexpr std::size_t kFixed = 5; // ext(2)+version/cni(1)+numbers(2)
    constexpr std::size_t kCrc = 4;
    const std::size_t section_length = kFixed + body_size + kCrc;
    std::vector<uint8_t> frame(3 + section_length, 0);
    frame[0] = table_id;
    frame[1] = 0xB0 | static_cast<uint8_t>((section_length >> 8) & 0x0F);
    frame[2] = static_cast<uint8_t>(section_length & 0xFF);
    frame[3] = static_cast<uint8_t>(extension >> 8);
    frame[4] = static_cast<uint8_t>(extension & 0xFF);
    frame[5] = static_cast<uint8_t>(((version & 0x1F) << 1) |
                                    (current_next ? 0x01 : 0x00));
    frame[6] = section_number;
    frame[7] = last_section;
    for (std::size_t i = 8; i < frame.size() - kCrc; ++i) {
        frame[i] = static_cast<uint8_t>((i * 31u + section_number * 7u +
                                         version * 13u + seed * 17u) & 0xFFu);
    }
    const uint32_t crc = crc32_mpeg2(frame.data(), frame.size() - kCrc);
    frame[frame.size() - 4] = static_cast<uint8_t>(crc >> 24);
    frame[frame.size() - 3] = static_cast<uint8_t>(crc >> 16);
    frame[frame.size() - 2] = static_cast<uint8_t>(crc >> 8);
    frame[frame.size() - 1] = static_cast<uint8_t>(crc);
    return frame;
}

// One-PID TS muxer used by the tests. Sections are concatenated into a byte
// stream and split over 188-byte packets. A section boundary inside a packet
// produces a PUSI packet whose pointer_field points at the new section.
class SplittingTsMux {
public:
    SplittingTsMux(uint16_t pid, uint8_t start_cc = 0)
        : pid_(pid), cc_(start_cc & 0x0F) {}

    void enqueue(std::vector<uint8_t> section) {
        stream_.insert(stream_.end(), section.begin(), section.end());
        boundaries_.push_back(stream_.size()); // absolute stream offset
    }

    void setAdaptationOnlyNext() { adaptation_only_next_ = true; }
    void simulateLostPacket() { cc_ = static_cast<uint8_t>((cc_ + 1) & 0x0F); }
    uint8_t nextContinuityCounter() const { return cc_; }

    std::vector<uint8_t> pullOne() {
        std::vector<uint8_t> packet(188, 0xFF);
        packet[0] = 0x47;

        if (adaptation_only_next_) {
            adaptation_only_next_ = false;
            packet[1] = static_cast<uint8_t>((pid_ >> 8) & 0x1F);
            packet[2] = static_cast<uint8_t>(pid_ & 0xFF);
            packet[3] = 0x20 | cc_; // adaptation only, CC unchanged
            packet[4] = 1;          // adaptation_length
            packet[5] = 0x00;       // no flags
            return packet;
        }

        const std::size_t boundary =
            boundaries_.empty() ? stream_.size() : boundaries_.front();
        const bool at_section_start = pos_ == 0 || pos_ == boundary;

        if (at_section_start) {
            // PUSI packet with pointer_field == 0: the section starts at the
            // first payload byte (packet[5]); at most 183 stream bytes fit.
            if (pos_ == 0 && !boundaries_.empty() && boundaries_.front() == 0) {
                boundaries_.erase(boundaries_.begin());
            } else if (pos_ != 0 && pos_ == boundary) {
                boundaries_.erase(boundaries_.begin());
            }
            const std::size_t take = std::min(remaining(), std::size_t{183});
            packet[1] = static_cast<uint8_t>(0x40 | ((pid_ >> 8) & 0x1F));
            packet[2] = static_cast<uint8_t>(pid_ & 0xFF);
            packet[3] = 0x10 | cc_;
            packet[4] = 0; // pointer_field
            std::memcpy(packet.data() + 5, stream_.data() + pos_, take);
            fillStuffing(packet, 5 + take);
            pos_ += take;
            cc_ = static_cast<uint8_t>((cc_ + 1) & 0x0F);
            return packet;
        }

        // We are inside a section. If its boundary fits in this packet with
        // at least one byte left for the next section, emit a pointer packet;
        // otherwise emit a plain continuation packet.
        const std::size_t bytes_to_boundary = boundary - pos_;
        if (!boundaries_.empty() && bytes_to_boundary <= 182) {
            // PUSI: [pointer_field][tail of old section][start of new one].
            const std::size_t pointer = bytes_to_boundary;
            const std::size_t window = 183 - pointer; // >= 1
            const std::size_t take =
                std::min(remaining() - pointer, window);
            const std::size_t written = pointer + take; // <= 183
            packet[1] = static_cast<uint8_t>(0x40 | ((pid_ >> 8) & 0x1F));
            packet[2] = static_cast<uint8_t>(pid_ & 0xFF);
            packet[3] = 0x10 | cc_;
            packet[4] = static_cast<uint8_t>(pointer);
            std::memcpy(packet.data() + 5, stream_.data() + pos_, written);
            fillStuffing(packet, 5 + written);
            pos_ += written;
            boundaries_.erase(boundaries_.begin());
            cc_ = static_cast<uint8_t>((cc_ + 1) & 0x0F);
            return packet;
        }

        // Continuation (PUSI=0): payload is packet[4..187], 184 bytes max,
        // and we never consume past the section boundary.
        std::size_t take = std::min(remaining(), std::size_t{184});
        if (!boundaries_.empty() && take > bytes_to_boundary) {
            take = bytes_to_boundary;
        }
        packet[1] = static_cast<uint8_t>((pid_ >> 8) & 0x1F);
        packet[2] = static_cast<uint8_t>(pid_ & 0xFF);
        packet[3] = 0x10 | cc_;
        std::memcpy(packet.data() + 4, stream_.data() + pos_, take);
        fillStuffing(packet, 4 + take);
        pos_ += take;
        cc_ = static_cast<uint8_t>((cc_ + 1) & 0x0F);
        return packet;
    }

    bool empty() const { return pos_ >= stream_.size(); }

private:
    std::size_t remaining() const { return stream_.size() - pos_; }

    static void fillStuffing(std::vector<uint8_t>& packet, std::size_t from) {
        for (std::size_t i = from; i < packet.size(); ++i) {
            packet[i] = 0xFF;
        }
    }

    uint16_t pid_;
    uint8_t cc_ = 0;
    bool adaptation_only_next_ = false;
    std::size_t pos_ = 0;
    std::vector<uint8_t> stream_;
    std::vector<std::size_t> boundaries_;
};

void feedAll(SectionAssembler& assembler,
             const std::vector<std::vector<uint8_t>>& packets) {
    for (const auto& packet : packets) {
        assembler.feed(packet.data(), packet.size());
    }
}

std::vector<std::vector<uint8_t>> drain(SplittingTsMux& mux) {
    std::vector<std::vector<uint8_t>> packets;
    while (!mux.empty()) {
        packets.push_back(mux.pullOne());
    }
    return packets;
}


void testVersionInterleavingNeverMixes() {
    constexpr uint16_t pid = 0x600;
    int publish_count = 0;
    PublishedTable last;
    SectionAssembler assembler(pid, [&](const PublishedTable& table) {
        ++publish_count;
        last = table;
    });
    SplittingTsMux mux(pid);

    // Interleave sections of versions 4 and 5 of the same table identity.
    mux.enqueue(makeSection(0x80, 0x0050, 4, true, 0, 1, 80));
    mux.enqueue(makeSection(0x80, 0x0050, 5, true, 0, 1, 80));
    mux.enqueue(makeSection(0x80, 0x0050, 4, true, 1, 1, 80));
    mux.enqueue(makeSection(0x80, 0x0050, 5, true, 1, 1, 80));
    feedAll(assembler, drain(mux));

    CHECK(publish_count == 2); // one atomic publish per complete version
    CHECK(assembler.stats().sections_crc_bad == 0);

    const auto cur = assembler.current(0x80, 0x0050);
    CHECK(cur.has_value());
    CHECK(cur->version == 5); // latest version owns the current slot
    for (const auto& section : cur->sections) {
        CHECK(section.version == 5); // no v4 fragment stitched into v5
    }
    CHECK(last.version == 5);
}

void testCurrentNextZeroCachedOnly() {
    constexpr uint16_t pid = 0x700;
    int publish_count = 0;
    SectionAssembler assembler(pid,
                               [&](const PublishedTable&) { ++publish_count; });
    SplittingTsMux mux(pid);
    mux.enqueue(makeSection(0x90, 0x0060, 7, false, 0, 0, 30));
    feedAll(assembler, drain(mux));

    CHECK(publish_count == 0);
    CHECK(!assembler.current(0x90, 0x0060).has_value());
    CHECK(assembler.stats().tables_cached_next == 1);

    // Same version with current_next == 1 now publishes atomically.
    SplittingTsMux mux2(pid, mux.nextContinuityCounter());
    mux2.enqueue(makeSection(0x90, 0x0060, 7, true, 0, 0, 30));
    feedAll(assembler, drain(mux2));
    CHECK(publish_count == 1);
    CHECK(assembler.current(0x90, 0x0060)->version == 7);
}

void testBadCrcRejected() {
    constexpr uint16_t pid = 0x800;
    int publish_count = 0;
    SectionAssembler assembler(pid,
                               [&](const PublishedTable&) { ++publish_count; });
    SplittingTsMux mux(pid);
    auto bad = makeSection(0xA0, 0x0070, 0, true, 0, 0, 30);
    bad[12] ^= 0xFF; // corrupt a body byte after the CRC was computed
    mux.enqueue(bad);
    feedAll(assembler, drain(mux));

    CHECK(assembler.stats().sections_crc_bad == 1);
    CHECK(publish_count == 0);
    CHECK(!assembler.current(0xA0, 0x0070).has_value());
}

void testAdaptationOnlyDoesNotDisturbCc() {
    constexpr uint16_t pid = 0x900;
    int publish_count = 0;
    SectionAssembler assembler(pid,
                               [&](const PublishedTable&) { ++publish_count; });
    SplittingTsMux mux(pid);
    mux.enqueue(makeSection(0xB0, 0x0080, 0, true, 0, 1, 250));
    mux.setAdaptationOnlyNext(); // repeats CC, carries no payload
    mux.enqueue(makeSection(0xB0, 0x0080, 0, true, 1, 1, 250));
    feedAll(assembler, drain(mux));

    CHECK(assembler.stats().packets_duplicate == 0);
    CHECK(assembler.stats().discontinuities == 0);
    CHECK(publish_count == 1);
}

void testForeignPidAndGarbageIgnored() {
    constexpr uint16_t pid = 0xA00;
    SectionAssembler assembler(pid);
    SplittingTsMux foreign(pid + 1);
    foreign.enqueue(makeSection(0xC0, 0x0090, 0, true, 0, 0, 20));
    for (const auto& packet : drain(foreign)) {
        assembler.feed(packet.data(), packet.size());
    }
    CHECK(assembler.stats().packets_total == 0);

    std::vector<uint8_t> wrong_size(100, 0xFF);
    assembler.feed(wrong_size.data(), wrong_size.size());
    std::vector<uint8_t> bad_sync(188, 0x00);
    assembler.feed(bad_sync.data(), bad_sync.size());
    CHECK(assembler.stats().packets_ignored >= 2);
}

void testAdaptationDiscontinuityFlagResetsPending() {
    constexpr uint16_t pid = 0xA01;
    int publish_count = 0;
    SectionAssembler assembler(pid,
                               [&](const PublishedTable&) { ++publish_count; });
    SplittingTsMux mux(pid);
    mux.enqueue(makeSection(0xC1, 0x0091, 0, true, 0, 1, 300));
    mux.enqueue(makeSection(0xC1, 0x0091, 0, true, 1, 1, 300));
    auto packets = drain(mux);

    // Adaptation+payload packet with the discontinuity flag set, injected
    // before the packet that would otherwise finish the first section.
    std::vector<uint8_t> disc(188, 0xFF);
    disc[0] = 0x47;
    disc[1] = static_cast<uint8_t>((pid >> 8) & 0x1F); // PUSI=0
    disc[2] = static_cast<uint8_t>(pid & 0xFF);
    disc[3] = 0x32; // adaptation + payload, CC=2
    disc[4] = 2;    // adaptation_length
    disc[5] = 0x80; // discontinuity_indicator
    disc[6] = 0x00;
    const std::size_t insert_at = packets.size() / 2;
    packets.insert(packets.begin() + static_cast<std::ptrdiff_t>(insert_at),
                   disc);
    feedAll(assembler, packets);

    CHECK(assembler.stats().discontinuities >= 1);
    CHECK(publish_count == 0); // pending assembly was discarded
}




void testCrcKnownVector() {
    // CRC-32/MPEG-2 of ASCII "123456789" is 0x0376E6E7.
    const char* s = "123456789";
    CHECK(crc32_mpeg2(reinterpret_cast<const uint8_t*>(s), 9) == 0x0376E6E7u);
}

void testBasicAssemblyAndAtomicPublish() {
    constexpr uint16_t pid = 0x100;
    int publish_count = 0;
    PublishedTable received;
    SectionAssembler assembler(pid, [&](const PublishedTable& table) {
        ++publish_count;
        received = table;
    });

    SplittingTsMux mux(pid);
    const std::size_t body = 300; // sections span multiple 184-byte payloads
    mux.enqueue(makeSection(0x42, 0x0001, 2, true, 0, 1, body));
    mux.enqueue(makeSection(0x42, 0x0001, 2, true, 1, 1, body));
    feedAll(assembler, drain(mux));

    CHECK(publish_count == 1);
    CHECK(received.table_id == 0x42);
    CHECK(received.table_id_extension == 0x0001);
    CHECK(received.version == 2);
    CHECK(received.sections.size() == 2);
    CHECK(received.sections[0].section_number == 0);
    CHECK(received.sections[1].section_number == 1);
    CHECK(assembler.current(0x42, 0x0001)->version == 2);
    CHECK(assembler.stats().tables_published == 1);
    CHECK(assembler.stats().sections_crc_bad == 0);
}

void testNoPublishBeforeComplete() {
    constexpr uint16_t pid = 0x200;
    int publish_count = 0;
    SectionAssembler assembler(pid,
                               [&](const PublishedTable&) { ++publish_count; });
    SplittingTsMux mux(pid);
    mux.enqueue(makeSection(0x44, 0x0010, 0, true, 0, 2, 100));
    mux.enqueue(makeSection(0x44, 0x0010, 0, true, 2, 2, 100)); // gap: no #1
    feedAll(assembler, drain(mux));

    CHECK(publish_count == 0);
    CHECK(!assembler.current(0x44, 0x0010).has_value());
    CHECK(assembler.stats().tables_published == 0);
}

void testPointerFinishesOldThenStartsNew() {
    constexpr uint16_t pid = 0x300;
    int publish_count = 0;
    SectionAssembler assembler(pid,
                               [&](const PublishedTable&) { ++publish_count; });
    SplittingTsMux mux(pid);

    const auto s0 = makeSection(0x50, 0x0020, 1, true, 0, 2, 200);
    const auto s1 = makeSection(0x50, 0x0020, 1, true, 1, 2, 200);
    const auto s2 = makeSection(0x50, 0x0020, 1, true, 2, 2, 200);
    mux.enqueue(s0);
    mux.enqueue(s1);
    mux.enqueue(s2);
    auto packets = drain(mux);

    bool saw_nonzero_pointer = false;
    for (const auto& packet : packets) {
        if ((packet[1] & 0x40) && packet[4] > 0) {
            saw_nonzero_pointer = true;
        }
    }
    CHECK(saw_nonzero_pointer);
    feedAll(assembler, packets);

    CHECK(publish_count == 1);
    const auto cur = assembler.current(0x50, 0x0020);
    CHECK(cur.has_value());
    CHECK(cur->sections.size() == 3);
    CHECK(cur->sections[0].data == s0);
    CHECK(cur->sections[1].data == s1);
    CHECK(cur->sections[2].data == s2);
}

void testMultipleSectionsInOnePacket() {
    constexpr uint16_t pid = 0x301;
    int publish_count = 0;
    SectionAssembler assembler(pid,
                               [&](const PublishedTable&) { ++publish_count; });
    SplittingTsMux mux(pid);
    for (uint8_t n = 0; n < 4; ++n) {
        mux.enqueue(makeSection(0x51, 0x0021, 0, true, n, 3, 10));
    }
    feedAll(assembler, drain(mux));

    CHECK(publish_count == 1);
    CHECK(assembler.current(0x51, 0x0021)->sections.size() == 4);
    CHECK(assembler.stats().sections_crc_bad == 0);
}



void testLostPacketResetsPending() {
    constexpr uint16_t pid = 0x400;
    int publish_count = 0;
    SectionAssembler assembler(pid,
                               [&](const PublishedTable&) { ++publish_count; });
    SplittingTsMux mux(pid);
    mux.enqueue(makeSection(0x60, 0x0030, 0, true, 0, 1, 300));
    mux.enqueue(makeSection(0x60, 0x0030, 0, true, 1, 1, 300));

    auto packets = drain(mux);
    CHECK(packets.size() >= 4);
    packets.erase(packets.begin() + 1); // drop a middle packet -> CC gap
    feedAll(assembler, packets);

    CHECK(assembler.stats().discontinuities >= 1);
    CHECK(publish_count == 0); // the corrupted table cannot publish

    // A fresh stream after re-sync still assembles correctly.
    SectionAssembler assembler2(pid,
                                [&](const PublishedTable&) { ++publish_count; });
    SplittingTsMux mux2(pid);
    mux2.simulateLostPacket(); // first observed CC is 1, not 0
    mux2.enqueue(makeSection(0x60, 0x0031, 0, true, 0, 0, 50));
    feedAll(assembler2, drain(mux2));
    CHECK(assembler2.current(0x60, 0x0031).has_value());
}

void testDuplicateSamePayloadIgnored() {
    constexpr uint16_t pid = 0x500;
    int publish_count = 0;
    SectionAssembler assembler(pid,
                               [&](const PublishedTable&) { ++publish_count; });
    SplittingTsMux mux(pid);
    mux.enqueue(makeSection(0x70, 0x0040, 3, true, 0, 0, 40));
    auto packets = drain(mux);

    feedAll(assembler, packets);
    CHECK(publish_count == 1);

    // Exact retransmission: same CC, identical payload.
    assembler.feed(packets.front().data(), packets.front().size());
    CHECK(assembler.stats().packets_duplicate == 1);
    CHECK(publish_count == 1);

    // Same CC but mutated payload must reset pending state.
    auto mutated = packets.front();
    mutated[100] ^= 0x01;
    assembler.feed(mutated.data(), mutated.size());
    CHECK(assembler.stats().discontinuities >= 1);
}

void testDuplicateSectionSamePayloadIgnored() {
    constexpr uint16_t pid = 0x501;
    int publish_count = 0;
    SectionAssembler assembler(pid,
                               [&](const PublishedTable&) { ++publish_count; });
    SplittingTsMux mux(pid);
    const auto s0 = makeSection(0x71, 0x0041, 0, true, 0, 1, 20);
    const auto s1 = makeSection(0x71, 0x0041, 0, true, 1, 1, 20);
    mux.enqueue(s0);
    mux.enqueue(s0); // retransmitted section before #1
    mux.enqueue(s1);
    feedAll(assembler, drain(mux));

    CHECK(assembler.stats().sections_duplicate >= 1);
    CHECK(publish_count == 1);
}

void testSameSlotDifferentPayloadResetsGroup() {
    constexpr uint16_t pid = 0x502;
    int publish_count = 0;
    SectionAssembler assembler(pid,
                               [&](const PublishedTable&) { ++publish_count; });
    SplittingTsMux mux(pid);
    mux.enqueue(makeSection(0x72, 0x0042, 0, true, 0, 1, 20));
    mux.enqueue(makeSection(0x72, 0x0042, 0, true, 1, 1, 20));
    feedAll(assembler, drain(mux));
    CHECK(publish_count == 1);

    // Same identity/slot number 0, different body content. Continue the CC
    // sequence so the assembler treats this as the same live PID.
    SplittingTsMux mux2(pid, mux.nextContinuityCounter());
    mux2.enqueue(makeSection(0x72, 0x0042, 0, true, 0, 1, 20, 1));
    mux2.enqueue(makeSection(0x72, 0x0042, 0, true, 1, 1, 20));
    feedAll(assembler, drain(mux2));

    CHECK(assembler.stats().sections_payload_changed >= 1);
    CHECK(publish_count == 2); // group rebuilt, one new atomic publish
    CHECK(assembler.current(0x72, 0x0042)->sections[0].data ==
          makeSection(0x72, 0x0042, 0, true, 0, 1, 20, 1));
}


} // namespace

int main() {
    testCrcKnownVector();
    testBasicAssemblyAndAtomicPublish();
    testNoPublishBeforeComplete();
    testPointerFinishesOldThenStartsNew();
    testMultipleSectionsInOnePacket();
    testLostPacketResetsPending();
    testDuplicateSamePayloadIgnored();
    testDuplicateSectionSamePayloadIgnored();
    testSameSlotDifferentPayloadResetsGroup();
    testVersionInterleavingNeverMixes();
    testCurrentNextZeroCachedOnly();
    testBadCrcRejected();
    testAdaptationOnlyDoesNotDisturbCc();
    testForeignPidAndGarbageIgnored();
    testAdaptationDiscontinuityFlagResetsPending();

    std::cout << "checks=" << g_checks << " failures=" << g_failures << "\n";
    return g_failures == 0 ? 0 : 1;
}
