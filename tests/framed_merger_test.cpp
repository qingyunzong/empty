#include "dataeng.hpp"

#include <cassert>
#include <cstdio>
#include <vector>

using namespace dataeng;

namespace {

std::vector<uint8_t> takeFirstN(const std::vector<uint8_t>& src,
                                std::size_t n) {
    return std::vector<uint8_t>(src.begin(), src.begin() + n);
}

std::vector<uint8_t> dropFirstN(const std::vector<uint8_t>& src,
                                std::size_t n) {
    return std::vector<uint8_t>(src.begin() + n, src.end());
}

void testBasicMatching() {
    std::vector<MergedFrame> got;
    FramedMerger merger([&](const MergedFrame& f) { got.push_back(f); });

    int32_t id_a = 0;
    int32_t id_b = 0;
    assert(merger.registerCall("getA", MessageType::Call, id_a) ==
           MergerError::None);
    assert(merger.registerCall("getB", MessageType::Call, id_b) ==
           MergerError::None);
    assert(id_a == 0 && id_b == 1);
    assert(merger.inFlightCount() == 2);

    std::vector<uint8_t> body_b{0x0A, 0x0B, 0x0C};
    auto frame_b =
        FramedMerger::buildFrame(id_b, MessageType::Reply, "getB", body_b);
    std::vector<uint8_t> body_a{0x01};
    auto frame_a =
        FramedMerger::buildFrame(id_a, MessageType::Reply, "getA", body_a);

    // Out-of-order responses must still pair correctly by seqid.
    assert(merger.feed(frame_b) == MergerError::None);
    assert(merger.feed(frame_a) == MergerError::None);

    assert(got.size() == 2);
    assert(got[0].seqid == id_b && got[0].method == "getB");
    assert(got[0].type == MessageType::Reply);
    assert(got[0].body == body_b);
    assert(got[1].seqid == id_a && got[1].method == "getA");
    assert(got[1].body == body_a);
    assert(merger.inFlightCount() == 0);
}

void testFragmentedFrame() {
    std::vector<MergedFrame> got;
    FramedMerger merger([&](const MergedFrame& f) { got.push_back(f); });

    int32_t id = 0;
    assert(merger.registerCall("ping", MessageType::Call, id) ==
           MergerError::None);
    auto frame = FramedMerger::buildFrame(
        id, MessageType::Reply, "ping", {1, 2, 3, 4, 5});

    // Feed byte by byte: no frame may be assembled prematurely or merged
    // across the boundary.
    for (std::size_t i = 0; i < frame.size(); ++i) {
        assert(merger.feed(&frame[i], 1) == MergerError::None);
        if (i + 1 < frame.size()) {
            assert(got.empty());
            assert(merger.bufferedBytes() == i + 1);
        }
    }
    assert(got.size() == 1);
    assert(got[0].seqid == id);
    assert(merger.bufferedBytes() == 0);
}

void testGluedAndSplitPrefix() {
    std::vector<MergedFrame> got;
    FramedMerger merger([&](const MergedFrame& f) { got.push_back(f); });

    int32_t id1 = 0;
    int32_t id2 = 0;
    merger.registerCall("m1", MessageType::Call, id1);
    merger.registerCall("m2", MessageType::Call, id2);

    auto f1 = FramedMerger::buildFrame(id1, MessageType::Reply, "m1", {9});
    auto f2 = FramedMerger::buildFrame(id2, MessageType::Reply, "m2", {8, 7});

    std::vector<uint8_t> glued;
    glued.insert(glued.end(), f1.begin(), f1.end());
    glued.insert(glued.end(), f2.begin(), f2.end());

    // Split across the length prefix boundary (3 bytes of prefix first).
    auto part1 = takeFirstN(glued, 3);
    auto part2 = dropFirstN(glued, 3);
    assert(merger.feed(part1) == MergerError::None);
    assert(got.empty());
    assert(merger.feed(part2) == MergerError::None);

    assert(got.size() == 2);
    assert(got[0].method == "m1" && got[1].method == "m2");
    assert(got[0].body == std::vector<uint8_t>({9}));
    assert(got[1].body == std::vector<uint8_t>({8, 7}));
}

void testFrameLengthLimit() {
    MergerConfig config;
    config.max_frame_bytes = 10;
    std::vector<MergedFrame> got;
    FramedMerger merger([&](const MergedFrame& f) { got.push_back(f); },
                        config);

    int32_t id = 0;
    merger.registerCall("big", MessageType::Call, id);
    std::vector<uint8_t> body(16, 0xAB);
    auto frame = FramedMerger::buildFrame(id, MessageType::Reply, "big", body);

    MergerError error = merger.feed(frame);
    assert(error == MergerError::FrameTooLarge);
    assert(merger.failed());
    assert(got.empty());

    // A failed stream rejects further input until reset().
    assert(merger.feed(frame) == MergerError::StreamFailed);
    merger.reset();
    assert(!merger.failed());
    assert(merger.bufferedBytes() == 0);
}

void testOnewayNeverAwaited() {
    std::vector<MergedFrame> got;
    FramedMerger merger([&](const MergedFrame& f) { got.push_back(f); });

    int32_t ow = 0;
    int32_t call = 0;
    assert(merger.registerCall("fire", MessageType::Oneway, ow) ==
           MergerError::None);
    assert(ow == 0);
    assert(merger.inFlightCount() == 0);  // nothing awaited
    assert(merger.registerCall("wait", MessageType::Call, call) ==
           MergerError::None);
    assert(call == 1);

    // A stray frame sharing the oneway seqid cannot match anything.
    auto stray = FramedMerger::buildFrame(ow, MessageType::Reply, "fire", {});
    assert(merger.feed(stray) == MergerError::UnknownSeqId);
    assert(got.empty());
    assert(merger.inFlightCount() == 1);
}

void testExceptionTerminatesOnlyOwnCall() {
    std::vector<MergedFrame> got;
    FramedMerger merger([&](const MergedFrame& f) { got.push_back(f); });

    int32_t id1 = 0;
    int32_t id2 = 0;
    int32_t id3 = 0;
    merger.registerCall("a", MessageType::Call, id1);
    merger.registerCall("b", MessageType::Call, id2);
    merger.registerCall("c", MessageType::Call, id3);

    auto exc = FramedMerger::buildFrame(id2, MessageType::Exception, "b",
                                        {0xDE, 0xAD});
    assert(merger.feed(exc) == MergerError::None);
    assert(got.size() == 1);
    assert(got[0].type == MessageType::Exception);
    assert(got[0].seqid == id2);

    // Only call b is terminated; a and c stay in flight.
    assert(merger.inFlightCount() == 2);
    auto rep_a = FramedMerger::buildFrame(id1, MessageType::Reply, "a", {});
    auto rep_c = FramedMerger::buildFrame(id3, MessageType::Reply, "c", {});
    assert(merger.feed(rep_a) == MergerError::None);
    assert(merger.feed(rep_c) == MergerError::None);
    assert(merger.inFlightCount() == 0);
}

void testSeqidWrapRejectsInFlight() {
    MergerConfig config;
    config.seqid_ceiling = 2;  // seqids 0,1,2
    std::vector<MergedFrame> got;
    FramedMerger merger([&](const MergedFrame& f) { got.push_back(f); },
                        config);

    int32_t i0 = 0, i1 = 0, i2 = 0, i3 = 0;
    assert(merger.registerCall("x", MessageType::Call, i0) ==
           MergerError::None);
    assert(merger.registerCall("x", MessageType::Call, i1) ==
           MergerError::None);
    assert(merger.registerCall("x", MessageType::Call, i2) ==
           MergerError::None);
    assert(i0 == 0 && i1 == 1 && i2 == 2);

    // The counter wraps to 0 while seqid 0 is still in flight.
    assert(merger.registerCall("x", MessageType::Call, i3) ==
           MergerError::SeqIdInFlight);
    assert(merger.inFlightCount() == 3);

    // Complete seqid 0; wrapping still lands on an in-flight seqid (1) only
    // after slot 0 is reused first. Free slot 0 and consume it, then the
    // next wrap must be rejected because seqid 1 is still in flight.
    auto rep0 = FramedMerger::buildFrame(i0, MessageType::Reply, "x", {});
    assert(merger.feed(rep0) == MergerError::None);
    int32_t reused = 0;
    assert(merger.registerCall("x", MessageType::Call, reused) ==
           MergerError::None);
    assert(reused == 0);
    assert(merger.registerCall("x", MessageType::Call, i3) ==
           MergerError::SeqIdInFlight);
    assert(merger.inFlightCount() == 3);

    // Complete seqid 1; the next call may now reuse it after wrapping.
    auto rep1 = FramedMerger::buildFrame(i1, MessageType::Reply, "x", {});
    assert(merger.feed(rep1) == MergerError::None);
    assert(merger.registerCall("x", MessageType::Call, i3) ==
           MergerError::None);
    assert(i3 == 1);
}

void testOnewayWrapAdvancesCounter() {
    MergerConfig config;
    config.seqid_ceiling = 1;  // seqids 0,1
    std::vector<MergedFrame> got;
    FramedMerger merger([&](const MergedFrame& f) { got.push_back(f); },
                        config);

    int32_t a = 0, b = 0, c = 0, d = 0;
    merger.registerCall("ow", MessageType::Oneway, a);
    merger.registerCall("ow", MessageType::Oneway, b);
    assert(a == 0 && b == 1);
    // Counter wrapped to 0; oneway never blocks a seqid.
    assert(merger.registerCall("ow", MessageType::Oneway, c) ==
           MergerError::None);
    assert(c == 0);
    assert(merger.registerCall("real", MessageType::Call, d) ==
           MergerError::None);
    assert(d == 1);
    assert(merger.inFlightCount() == 1);
}

void testMethodAndTypeMismatch() {
    std::vector<MergedFrame> got;
    FramedMerger merger([&](const MergedFrame& f) { got.push_back(f); });

    int32_t id = 0;
    merger.registerCall("real", MessageType::Call, id);

    auto wrong_method =
        FramedMerger::buildFrame(id, MessageType::Reply, "other", {});
    assert(merger.feed(wrong_method) == MergerError::MethodMismatch);
    assert(merger.inFlightCount() == 1);  // call not completed
    assert(!merger.failed());             // stream stays healthy

    // A server frame carrying a Call type is not a valid response.
    auto bad_type =
        FramedMerger::buildFrame(id, MessageType::Call, "real", {});
    assert(merger.feed(bad_type) == MergerError::MalformedFrame);
    assert(merger.failed());
}

void testMalformedFrame() {
    std::vector<MergedFrame> got;
    FramedMerger merger([&](const MergedFrame& f) { got.push_back(f); });
    int32_t id = 0;
    merger.registerCall("m", MessageType::Call, id);

    // Length prefix claims 6 bytes but the body is not a binary header.
    std::vector<uint8_t> junk = {0, 0, 0, 6, 1, 2, 3, 4, 5, 6};
    assert(merger.feed(junk) == MergerError::MalformedFrame);
    assert(merger.failed());
}

void testTruncatedPrefixAndFrame() {
    std::vector<MergedFrame> got;
    FramedMerger merger([&](const MergedFrame& f) { got.push_back(f); });
    int32_t id = 0;
    merger.registerCall("m", MessageType::Call, id);
    auto frame = FramedMerger::buildFrame(id, MessageType::Reply, "m",
                                          {1, 2, 3});

    // First two prefix bytes only.
    merger.feed(takeFirstN(frame, 2));
    assert(got.empty() && merger.bufferedBytes() == 2);
    // Remaining bytes complete the frame; no neighbor data exists.
    merger.feed(dropFirstN(frame, 2));
    assert(got.size() == 1);
    assert(got[0].body == std::vector<uint8_t>({1, 2, 3}));
    assert(merger.bufferedBytes() == 0);
}

}  // namespace

int main() {
    testBasicMatching();
    testFragmentedFrame();
    testGluedAndSplitPrefix();
    testFrameLengthLimit();
    testOnewayNeverAwaited();
    testExceptionTerminatesOnlyOwnCall();
    testSeqidWrapRejectsInFlight();
    testOnewayWrapAdvancesCounter();
    testMethodAndTypeMismatch();
    testMalformedFrame();
    testTruncatedPrefixAndFrame();
    std::printf("all framed merger tests passed\n");
    return 0;
}
