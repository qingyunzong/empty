// Tests for the persistent rope. Run with a filter argument:
//   rope_tests [unit|utf8|random|lifetime|overflow|all]

#include <rope/rope.hpp>

#include <cstdint>
#include <cstdio>
#include <random>
#include <string>
#include <string_view>
#include <vector>

namespace {

int g_failures = 0;
int g_checks = 0;

#define CHECK(cond)                                                        \
    do {                                                                   \
        ++g_checks;                                                        \
        if (!(cond)) {                                                     \
            ++g_failures;                                                  \
            std::fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__,   \
                         #cond);                                           \
        }                                                                  \
    } while (0)

// Reference boundary logic on a plain string (same contract as Rope).
bool ref_boundary(const std::string& s, size_t pos) {
    if (pos == 0 || pos == s.size())
        return true;
    return (static_cast<unsigned char>(s[pos]) & 0xC0) != 0x80;
}

size_t ref_floor(const std::string& s, size_t pos) {
    if (pos > s.size())
        pos = s.size();
    while (pos > 0 && !ref_boundary(s, pos))
        --pos;
    return pos;
}

size_t ref_ceil(const std::string& s, size_t pos) {
    if (pos > s.size())
        pos = s.size();
    while (pos < s.size() && !ref_boundary(s, pos))
        ++pos;
    return pos;
}

// ---------------------------------------------------------------- unit --

void test_unit() {
    using rope::Rope;

    // Empty rope behaviour.
    Rope e;
    CHECK(e.empty());
    CHECK(e.size() == 0);
    CHECK(e.to_string().empty());
    CHECK(e.is_char_boundary(0));
    CHECK(e.concat(e).empty());
    CHECK(e.slice(0, 0).empty());

    // Basic concat / slice / replace.
    Rope hello = Rope::from("hello");
    Rope world = Rope::from(" world");
    Rope hw = hello.concat(world);
    CHECK(hw.size() == 11);
    CHECK(hw.to_string() == "hello world");
    CHECK(hw.slice(0, 5).to_string() == "hello");
    CHECK(hw.slice(6, 5).to_string() == "world");
    CHECK(hw.slice(3, 4).to_string() == "lo w");
    CHECK(hw.slice(0, 11).to_string() == "hello world");
    CHECK(hw.slice(11, 0).to_string().empty());

    // Persistence: the old view is retained after derived edits.
    Rope replaced = hw.replace(6, 5, "UTF-8 \xE4\xB8\x96\xE7\x95\x8C");
    CHECK(hw.to_string() == "hello world"); // untouched
    CHECK(replaced.to_string() ==
          std::string("hello UTF-8 \xE4\xB8\x96\xE7\x95\x8C"));
    Rope inserted = hw.insert(5, ",");
    CHECK(inserted.to_string() == "hello, world");
    CHECK(hw.to_string() == "hello world");
    Rope erased = hw.erase(5, 6);
    CHECK(erased.to_string() == "hello");
    CHECK(hw.to_string() == "hello world");

    // Large input is chunked into multiple leaves but reads back whole.
    std::string big(10000, 'x');
    for (size_t i = 0; i < big.size(); i += 97)
        big[i] = static_cast<char>('a' + (i / 97) % 26);
    Rope br = Rope::from(big);
    CHECK(br.size() == big.size());
    CHECK(br.to_string() == big);
    CHECK(br.slice(1234, 4321).to_string() == big.substr(1234, 4321));

    // byte_at agrees with the plain string everywhere.
    for (size_t i = 0; i < big.size(); i += 13)
        CHECK(br.byte_at(i) == big[i]);

    // Out-of-range access throws.
    bool threw = false;
    try {
        hw.slice(10, 5);
    } catch (const std::out_of_range&) {
        threw = true;
    }
    CHECK(threw);
    threw = false;
    try {
        hw.byte_at(11);
    } catch (const std::out_of_range&) {
        threw = true;
    }
    CHECK(threw);
}

// ----------------------------------------------------------------- utf8 --

void test_utf8() {
    using rope::Rope;
    // Multi-byte content: 2-, 3- and 4-byte sequences.
    const std::string s = std::string("a\xC3\xA9"     // a é
                                      "b\xE4\xB8\x96" // b 世
                                      "\xE7\x95\x8C"   // 界
                                      "\xF0\x9F\x8C\x8Dz"); // 🌍 z

    Rope whole = Rope::from(s);
    CHECK(whole.to_string() == s);

    // Boundary queries on the intact rope match the reference.
    for (size_t p = 0; p <= s.size(); ++p) {
        CHECK(whole.is_char_boundary(p) == ref_boundary(s, p));
        CHECK(whole.floor_char_boundary(p) == ref_floor(s, p));
        CHECK(whole.ceil_char_boundary(p) == ref_ceil(s, p));
    }

    // Split at EVERY byte offset -- including inside multi-byte chars --
    // and verify boundary queries still agree with the plain string.
    for (size_t cut = 0; cut <= s.size(); ++cut) {
        Rope joined = Rope::from(std::string_view(s).substr(0, cut))
                          .concat(Rope::from(std::string_view(s).substr(cut)));
        CHECK(joined.to_string() == s);
        for (size_t p = 0; p <= s.size(); ++p) {
            CHECK(joined.is_char_boundary(p) == ref_boundary(s, p));
            CHECK(joined.floor_char_boundary(p) == ref_floor(s, p));
            CHECK(joined.ceil_char_boundary(p) == ref_ceil(s, p));
        }
    }

    // Slice at arbitrary byte offsets (may start/end mid-character) and
    // query boundaries of the resulting view against its plain twin.
    for (size_t pos = 0; pos <= s.size(); ++pos) {
        for (size_t len = 0; pos + len <= s.size(); ++len) {
            Rope view = whole.slice(pos, len);
            std::string plain = s.substr(pos, len);
            CHECK(view.to_string() == plain);
            for (size_t p = 0; p <= plain.size(); ++p) {
                CHECK(view.is_char_boundary(p) == ref_boundary(plain, p));
                CHECK(view.floor_char_boundary(p) == ref_floor(plain, p));
                CHECK(view.ceil_char_boundary(p) == ref_ceil(plain, p));
            }
        }
    }
}

// --------------------------------------------------------------- random --

void test_random() {
    using rope::Rope;
    std::mt19937_64 rng(20261005);

    const std::vector<std::string> pieces = {
        "",        "a",      "bc",           "hello ",
        "\xC3\xA9",                          // é
        "\xE4\xB8\x96\xE7\x95\x8C",          // 世界
        "\xF0\x9F\x8C\x8D",                  // 🌍
        "The quick brown fox. ",
        std::string(300, 'q'),               // forces leaf splits
        std::string(2500, 'Z'),              // forces multi-leaf chunks
    };

    Rope r;
    std::string oracle;
    std::vector<std::pair<Rope, std::string>> snapshots; // old views

    for (int iter = 0; iter < 4000; ++iter) {
        unsigned op = static_cast<unsigned>(rng() % 100);
        if (op < 40 || oracle.empty()) {
            // insert random piece at random byte position
            const std::string& p = pieces[rng() % pieces.size()];
            size_t pos = rng() % (oracle.size() + 1);
            r = r.insert(pos, Rope::from(p));
            oracle.insert(pos, p);
        } else if (op < 60) {
            // erase random range
            size_t pos = rng() % (oracle.size() + 1);
            size_t len = rng() % (oracle.size() - pos + 1);
            r = r.erase(pos, len);
            oracle.erase(pos, len);
        } else if (op < 80) {
            // replace random range with random piece
            const std::string& p = pieces[rng() % pieces.size()];
            size_t pos = rng() % (oracle.size() + 1);
            size_t len = rng() % (oracle.size() - pos + 1);
            r = r.replace(pos, len, Rope::from(p));
            oracle.replace(pos, len, p);
        } else if (op < 90) {
            // snapshot the current view (persistence check later)
            snapshots.emplace_back(r, oracle);
        } else {
            // snapshot a random sub-view
            size_t pos = rng() % (oracle.size() + 1);
            size_t len = rng() % (oracle.size() - pos + 1);
            snapshots.emplace_back(r.slice(pos, len), oracle.substr(pos, len));
        }

        // Periodic full comparison plus boundary-query comparison.
        if (iter % 37 == 0) {
            CHECK(r.size() == oracle.size());
            CHECK(r.to_string() == oracle);
            for (int k = 0; k < 8 && !oracle.empty(); ++k) {
                size_t p = rng() % (oracle.size() + 1);
                CHECK(r.is_char_boundary(p) == ref_boundary(oracle, p));
                CHECK(r.floor_char_boundary(p) == ref_floor(oracle, p));
                CHECK(r.ceil_char_boundary(p) == ref_ceil(oracle, p));
            }
        }
    }

    CHECK(r.to_string() == oracle);

    // Every retained old view must still read back exactly what it was.
    for (const auto& [view, expected] : snapshots)
        CHECK(view.to_string() == expected);
}

// -------------------------------------------------------------- lifetime --

void test_lifetime() {
    using rope::Rope;
    const size_t base = Rope::live_node_count();

    std::string big(8000, 'm');
    size_t after_build = 0;
    {
        Rope a = Rope::from(big);
        after_build = Rope::live_node_count();
        CHECK(after_build > base); // a tree of leaves exists now

        // concat shares a's nodes: only a thin layer of new nodes.
        Rope b = a.concat(a);
        size_t after_concat = Rope::live_node_count();
        CHECK(after_concat - after_build <= 4);
        CHECK(b.size() == 2 * big.size());

        // A middle slice shares whole subtrees where possible.
        Rope c = b.slice(4000, 4000);
        CHECK(c.to_string() == big.substr(4000, 4000));

        // Interior slice keeps only what it needs alive.
        Rope d = b.slice(10, 100);
        CHECK(d.to_string() == big.substr(10, 100));

        // Drop the originals; derived views keep shared nodes alive.
        a = Rope();
        b = Rope();
        CHECK(Rope::live_node_count() < after_concat);
        CHECK(c.to_string() == big.substr(4000, 4000)); // shared nodes survived
        CHECK(d.to_string() == big.substr(10, 100));

        size_t with_views = Rope::live_node_count();
        CHECK(with_views > base);
        c = Rope();
        d = Rope();
        // Both views gone: everything they held is reclaimed.
        CHECK(Rope::live_node_count() == base);
    }
    CHECK(Rope::live_node_count() == base);

    // Copies of a Rope handle share nodes; resetting one keeps the rest.
    {
        Rope x = Rope::from("shared payload");
        size_t n1 = Rope::live_node_count();
        {
            Rope y = x;
            Rope z = y;
            CHECK(Rope::live_node_count() == n1); // no new nodes
        }
        CHECK(Rope::live_node_count() == n1);     // nothing reclaimed yet
        CHECK(x.to_string() == "shared payload");
    }
    CHECK(Rope::live_node_count() == base);
}

// -------------------------------------------------------------- overflow --

void test_overflow() {
    // Checked length arithmetic: overflow throws instead of wrapping.
    CHECK(rope::detail::checked_add(3, 4) == 7);
    CHECK(rope::detail::checked_add(0, 0) == 0);
    const size_t mx = std::numeric_limits<size_t>::max();
    CHECK(rope::detail::checked_add(mx, 0) == mx);
    CHECK(rope::detail::checked_add(mx - 1, 1) == mx);

    bool threw = false;
    try {
        rope::detail::checked_add(mx, 1);
    } catch (const std::length_error&) {
        threw = true;
    }
    CHECK(threw);

    threw = false;
    try {
        rope::detail::checked_add(mx / 2 + 1, mx / 2 + 1);
    } catch (const std::length_error&) {
        threw = true;
    }
    CHECK(threw);

    // Concatenating real ropes never corrupts the cached length.
    rope::Rope a = rope::Rope::from(std::string(5000, 'a'));
    rope::Rope b = rope::Rope::from(std::string(7000, 'b'));
    CHECK(a.concat(b).size() == 12000);
}

} // namespace

int main(int argc, char** argv) {
    const std::string filter = argc > 1 ? argv[1] : "all";
    auto want = [&](const char* name) {
        return filter == "all" || filter == name;
    };

    if (want("unit")) test_unit();
    if (want("utf8")) test_utf8();
    if (want("random")) test_random();
    if (want("lifetime")) test_lifetime();
    if (want("overflow")) test_overflow();

    std::printf("%s: %d checks, %d failures\n", filter.c_str(), g_checks,
                g_failures);
    return g_failures == 0 ? 0 : 1;
}
