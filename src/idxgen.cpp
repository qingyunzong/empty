// idxgen: generates idx64 test files, including extreme-value and
// truncated cases.
//
// usage: idxgen <case> <output-file>
//   cases: valid empty shared zero-len-inside overlap nested
//          overflow-end max-end-beyond-file beyond-file huge-count
//          truncated-table truncated-header bad-magic

#include "idx64/index.hpp"

#include <cstdint>
#include <cstdio>
#include <fstream>
#include <string>
#include <string_view>
#include <vector>

namespace {

void put_u64le(std::vector<std::byte>& out, std::uint64_t v) {
    for (unsigned i = 0; i < 8; ++i)
        out.push_back(static_cast<std::byte>((v >> (8 * i)) & 0xff));
}

struct Builder {
    std::vector<std::byte> bytes;

    void header(std::uint64_t count) {
        for (char c : idx64::kMagic)
            bytes.push_back(static_cast<std::byte>(c));
        put_u64le(bytes, count);
    }
    void record(std::uint64_t offset, std::uint64_t length) {
        put_u64le(bytes, offset);
        put_u64le(bytes, length);
    }
    void payload(std::size_t n) {
        for (std::size_t i = 0; i < n; ++i)
            bytes.push_back(static_cast<std::byte>(i & 0xff));
    }
    void truncate(std::size_t n) { bytes.resize(n); }
};

bool write_file(const std::string& path, const std::vector<std::byte>& data) {
    std::ofstream out(path, std::ios::binary);
    if (!out)
        return false;
    out.write(reinterpret_cast<const char*>(data.data()),
              static_cast<std::streamsize>(data.size()));
    return static_cast<bool>(out);
}

// Builds the named case into `b`. Returns false for unknown cases.
bool build(std::string_view name, Builder& b) {
    constexpr std::uint64_t M = UINT64_MAX;
    if (name == "valid") {
        b.header(3);
        b.record(48, 16);   // inside the record table/payload area
        b.record(64, 32);   // adjacent: touching intervals are allowed
        b.record(128, 0);   // zero-length exactly at end of file
        b.payload(64);      // file = 16 + 48 + 64 = 128 bytes
        return true;
    }
    if (name == "empty") {
        b.header(0);
        return true;
    }
    if (name == "shared") {
        b.header(3);
        b.record(64, 16);
        b.record(64, 16); // identical: shared, allowed
        b.record(80, 8);
        b.payload(24);    // file = 16 + 48 + 24 = 88 bytes
        return true;
    }
    if (name == "zero-len-inside") {
        b.header(2);
        b.record(48, 32);
        b.record(60, 0); // empty segment occupies no bytes: allowed
        b.payload(32);   // file = 16 + 32 + 32 = 80 bytes
        return true;
    }
    if (name == "overlap") {
        b.header(2);
        b.record(48, 32);
        b.record(70, 16); // partial overlap with previous
        b.payload(40);    // file = 16 + 32 + 40 = 88 bytes
        return true;
    }
    if (name == "nested") {
        b.header(2);
        b.record(48, 40);
        b.record(56, 8); // fully nested: still a partial overlap
        b.payload(40);   // file = 16 + 32 + 40 = 88 bytes
        return true;
    }
    if (name == "overflow-end") {
        b.header(1);
        b.record(M, 1); // offset + length wraps past 2^64
        b.payload(8);
        return true;
    }
    if (name == "max-end-beyond-file") {
        b.header(1);
        b.record(M, 0); // end = 2^64 - 1, no overflow, but past file
        b.payload(8);
        return true;
    }
    if (name == "beyond-file") {
        b.header(1);
        b.record(24, 16); // end = 40 > file size 32
        return true;      // file = 16 + 16 = 32 bytes
    }
    if (name == "huge-count") {
        b.header(M); // count * 16 + 16 overflows uint64
        return true;
    }
    if (name == "truncated-table") {
        b.header(3);
        b.record(0, 0); // only one of three records present
        return true;
    }
    if (name == "truncated-header") {
        b.header(0);
        b.truncate(4);
        return true;
    }
    if (name == "bad-magic") {
        b.header(0);
        b.bytes[0] = std::byte{'X'};
        return true;
    }
    return false;
}

} // namespace

int main(int argc, char** argv) {
    if (argc != 3) {
        std::fprintf(stderr, "usage: idxgen <case> <output-file>\n");
        return 2;
    }
    Builder b;
    if (!build(argv[1], b)) {
        std::fprintf(stderr, "idxgen: unknown case '%s'\n", argv[1]);
        return 2;
    }
    if (!write_file(argv[2], b.bytes)) {
        std::fprintf(stderr, "idxgen: cannot write '%s'\n", argv[2]);
        return 2;
    }
    std::printf("wrote %s (%zu bytes)\n", argv[2], b.bytes.size());
    return 0;
}
