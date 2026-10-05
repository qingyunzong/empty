// Differential test: the production parser (checked uint64 arithmetic)
// is compared against the arbitrary-precision reference checker on
// deterministic pseudo-random inputs biased toward extreme values,
// truncations, and near-overlapping intervals.

#include "idx64/index.hpp"
#include "reference.hpp"

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

namespace {

std::uint64_t rng_state = 0x9e3779b97f4a7c15ULL;

std::uint64_t rng() { // splitmix64
    std::uint64_t z = (rng_state += 0x9e3779b97f4a7c15ULL);
    z = (z ^ (z >> 30)) * 0xbf58476d1ce4e5b9ULL;
    z = (z ^ (z >> 27)) * 0x94d049bb133111ebULL;
    return z ^ (z >> 31);
}

void put_u64le(std::vector<std::byte>& out, std::uint64_t v) {
    for (unsigned i = 0; i < 8; ++i)
        out.push_back(static_cast<std::byte>((v >> (8 * i)) & 0xff));
}

std::uint64_t rand_u64(std::uint64_t lo, std::uint64_t hi) { // [lo, hi]
    return lo + rng() % (hi - lo + 1);
}

// Pick a value biased toward interesting boundaries.
std::uint64_t rand_value(std::uint64_t file_size) {
    constexpr std::uint64_t M = UINT64_MAX;
    switch (rng() % 8) {
    case 0: return rand_u64(0, file_size + 2);
    case 1: return rand_u64(M - 3, M);
    case 2: return rng();
    case 3: return 0;
    case 4: return file_size;
    case 5: return M;
    case 6: return rand_u64(0, 64);
    default: return M - rand_u64(0, 1);
    }
}

std::vector<std::byte> make_file() {
    std::vector<std::byte> out;
    // Occasionally corrupt the magic.
    const char* magic = (rng() % 32 == 0) ? "JDX64V1" : "IDX64V1";
    for (int i = 0; i < 8; ++i)
        out.push_back(static_cast<std::byte>(magic[i]));

    const std::uint64_t count = [&] {
        switch (rng() % 16) {
        case 0: return UINT64_MAX;
        case 1: return (UINT64_MAX - 16) / 16;      // largest non-overflowing
        case 2: return (UINT64_MAX - 16) / 16 + 1;  // first overflowing
        case 3: return rand_u64(0, 1 << 20);
        default: return rand_u64(0, 6);
        }
    }();
    put_u64le(out, count);

    // Only materialize tables of plausible size; huge counts leave the
    // file truncated on purpose.
    std::vector<std::pair<std::uint64_t, std::uint64_t>> segs;
    if (count <= 6) {
        // Estimate final file size to bias offsets/lengths.
        const std::uint64_t file_size =
            16 + 16 * count + rand_u64(0, 48);
        for (std::uint64_t i = 0; i < count; ++i) {
            std::uint64_t off, len;
            const unsigned mode = rng() % 8;
            if (mode == 0 && !segs.empty()) {
                off = segs.front().first;   // shared: identical segment
                len = segs.front().second;
            } else if (mode == 1 && !segs.empty()) {
                off = segs.front().first;   // same start, other length
                len = rand_value(file_size);
            } else if (mode == 2 && !segs.empty()) {
                off = segs.back().first + segs.back().second; // touching
                len = rand_u64(0, 4);
                if (off < segs.back().first) // wrapped
                    off = rand_value(file_size);
            } else if (mode == 3 && !segs.empty()) {
                off = segs.back().first + rand_u64(0, 2); // near-overlap
                len = rand_u64(0, 8);
            } else {
                off = rand_value(file_size);
                len = rand_value(file_size);
            }
            segs.emplace_back(off, len);
            put_u64le(out, off);
            put_u64le(out, len);
        }
        out.resize(static_cast<std::size_t>(file_size), std::byte{0});
    }

    // Occasionally truncate or corrupt a random byte.
    if (rng() % 4 == 0 && !out.empty())
        out.resize(static_cast<std::size_t>(rng() % out.size()));
    if (rng() % 8 == 0 && !out.empty())
        out[static_cast<std::size_t>(rng() % out.size())] =
            static_cast<std::byte>(rng());
    return out;
}

} // namespace

int main(int argc, char** argv) {
    const long iterations = (argc > 1) ? std::atol(argv[1]) : 300000;
    long valid = 0;
    for (long i = 0; i < iterations; ++i) {
        const std::vector<std::byte> file = make_file();
        const auto got = idx64::Index::parse(file);
        const auto want = ref::reference_parse(file);
        if (got.has_value() == want.has_value() ||
            (!got && got.error() != *want)) {
            std::fprintf(stderr,
                         "MISMATCH at iteration %ld: library=%s reference=%s\n",
                         i,
                         got ? "OK" : std::string(idx64::to_string(got.error())).c_str(),
                         want ? std::string(idx64::to_string(*want)).c_str() : "OK");
            std::fprintf(stderr, "file (%zu bytes):", file.size());
            for (std::size_t k = 0; k < file.size() && k < 128; ++k)
                std::fprintf(stderr, " %02x",
                             std::to_integer<unsigned>(file[k]));
            std::fprintf(stderr, "\n");
            return EXIT_FAILURE;
        }
        if (got) {
            ++valid;
            // Read-only views must never exceed the file.
            for (std::size_t s = 0; s < got->segments().size(); ++s) {
                const auto view = got->segment_view(file, s);
                if (!view || view->size() != got->segments()[s].length ||
                    view->data() < file.data() ||
                    view->data() + view->size() > file.data() + file.size()) {
                    std::fprintf(stderr,
                                 "segment_view out of bounds at iteration %ld\n", i);
                    return EXIT_FAILURE;
                }
            }
        }
    }
    std::printf("crosscheck: %ld iterations, %ld valid, all matched reference\n",
                iterations, valid);
    return EXIT_SUCCESS;
}
