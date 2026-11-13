#include <cassert>
#include <iostream>
#include <string>

#include "dataeng.hpp"

using dataeng::bitemporal_store;
using store_t = bitemporal_store<std::string, int>;

static void test_basic_put_and_as_of() {
    store_t s;
    s.put("a", 1, 10, 20, 100);
    assert(s.as_of("a", 10, 100) == 1);
    assert(s.as_of("a", 19, 100) == 1);
    assert(s.as_of("a", 15, 1000) == 1);  // still current in system time
    assert(!s.as_of("a", 9, 100));        // before valid_from
    assert(!s.as_of("a", 20, 100));       // valid_to is exclusive
    assert(!s.as_of("a", 15, 99));        // before sys_from
    assert(!s.as_of("b", 15, 100));       // unknown key
}

static void test_retroactive_correction() {
    store_t s;
    s.put("a", 1, 10, 20, 100);   // original version
    s.put("a", 2, 15, 25, 200);   // retroactive correction, overlaps

    // History is not overwritten: as-at 100 still shows the old value.
    assert(s.as_of("a", 16, 100) == 1);
    assert(s.as_of("a", 16, 199) == 1);
    // After the correction the overlapping range reports the new value.
    assert(s.as_of("a", 16, 200) == 2);
    // Non-overlapping remainders of the old version stay visible.
    assert(s.as_of("a", 12, 200) == 1);
    // The correction's own extension is visible too.
    assert(s.as_of("a", 22, 200) == 2);
    assert(!s.as_of("a", 22, 100));

    // Audit trail: original closed at 200, remainder + new version added.
    auto h = s.history("a");
    assert(h.size() == 3);
    assert(h[0].value == 1 && h[0].valid_from == 10 && h[0].valid_to == 20);
    assert(h[0].sys_from == 100 && h[0].sys_to == 200);  // closed
    assert(h[1].value == 1 && h[1].valid_from == 10 && h[1].valid_to == 15);
    assert(h[1].sys_to == store_t::infinity);            // remainder
    assert(h[2].value == 2 && h[2].valid_from == 15 && h[2].valid_to == 25);
    assert(h[2].is_current());
}

static void test_delete_as_tombstone() {
    store_t s;
    s.put("a", 1, 10, 30, 100);
    const auto& tomb = s.erase("a", 15, 20, 200);
    assert(tomb.is_tombstone());

    // Deleted range is gone as-at 200, intact as-at 100.
    assert(!s.as_of("a", 17, 200));
    assert(s.as_of("a", 17, 100) == 1);
    // Remainders on both sides survive.
    assert(s.as_of("a", 12, 200) == 1);
    assert(s.as_of("a", 25, 200) == 1);
    // Tombstone boundaries are half-open.
    assert(s.as_of("a", 15, 200) == std::nullopt);
    assert(s.as_of("a", 20, 200) == 1);

    // Tombstones are hidden from as_at by default, visible on request.
    auto live = s.as_at(200);
    for (const auto& r : live) assert(!r.is_tombstone());
    auto all = s.as_at(200, true);
    bool saw_tombstone = false;
    for (const auto& r : all) saw_tombstone |= r.is_tombstone();
    assert(saw_tombstone);
}

static void test_uniqueness_and_snapshot() {
    store_t s;
    s.put("a", 1, 0, 50, 100);
    s.put("a", 2, 10, 40, 200);   // split into 3 current segments
    s.put("b", 7, 0, 50, 300);
    s.erase("a", 20, 30, 400);    // tombstone inside the correction

    // At every sampled (valid, sys) point each key resolves uniquely.
    for (std::int64_t v = 0; v < 50; ++v) {
        for (std::int64_t t : {99, 100, 150, 200, 250, 300, 400, 500}) {
            std::size_t visible = 0;
            for (const auto& r : s.records()) {
                if (r.key == "a" && r.visible_at(v, t)) ++visible;
            }
            assert(visible <= 1);
        }
    }

    auto snap = s.snapshot(25, 400);
    assert(snap.size() == 1);          // "a" tombstoned at 25, "b" live
    assert(snap.at("b") == 7);
    assert(s.snapshot(35, 400).at("a") == 2);
    assert(s.snapshot(45, 400).at("a") == 1);
    assert(s.snapshot(25, 100).at("a") == 1);  // pre-correction view
}

static void test_same_timestamp_and_validation() {
    store_t s;
    s.put("a", 1, 0, 10, 100);
    s.put("a", 2, 0, 10, 100);  // same sys time: old version closed at 100
    assert(s.as_of("a", 5, 100) == 2);
    std::size_t visible = 0;
    for (const auto& r : s.records()) {
        if (r.visible_at(5, 100)) ++visible;
    }
    assert(visible == 1);

    bool threw = false;
    try {
        s.put("a", 3, 10, 10, 200);  // empty interval
    } catch (const std::invalid_argument&) {
        threw = true;
    }
    assert(threw);
    threw = false;
    try {
        s.erase("a", 20, 10, 200);  // inverted interval
    } catch (const std::invalid_argument&) {
        threw = true;
    }
    assert(threw);
}

int main() {
    test_basic_put_and_as_of();
    test_retroactive_correction();
    test_delete_as_tombstone();
    test_uniqueness_and_snapshot();
    test_same_timestamp_and_validation();
    std::cout << "all bitemporal tests passed\n";
    return 0;
}
