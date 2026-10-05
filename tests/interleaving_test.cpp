#include "check.hpp"
#include "counting_mapper.hpp"

#include <array>
#include <cstddef>
#include <optional>

using pagefile::PageFile;

namespace {

constexpr std::size_t kInitialSize = 64;
constexpr std::size_t kViewSlots = 3;

// Deterministic harness replaying one operation sequence against a fresh
// PageFile, cross-checking view contents and mapper release counts after
// every single step.
struct Harness {
    Harness() {
        slots[0].emplace(mapper, kInitialSize);
        refill(); // current generation := fill byte 1
    }

    void refill() {
        slots[current]->fill(std::byte{next_fill});
        current_fill = next_fill;
        next_fill = std::byte{static_cast<unsigned char>(
            (static_cast<unsigned int>(next_fill) % 200) + 1)};
    }

    void acquire() {
        for (std::size_t i = 0; i < kViewSlots; ++i) {
            if (views[i].has_value()) {
                continue;
            }
            auto view = slots[current]->acquire();
            // A view is handed out iff the active slot is not closed.
            CHECK(view.has_value() == !slots[current]->is_closed());
            if (view.has_value()) {
                view_fill[i] = current_fill;
                view_size[i] = current_size;
                views[i] = std::move(*view);
            }
            return;
        }
    }

    void close() { slots[current]->close(); }

    void expand() {
        const std::size_t new_size = current_size * 2;
        if (slots[current]->is_closed()) {
            bool threw = false;
            try {
                slots[current]->expand(new_size);
            } catch (const std::logic_error&) {
                threw = true;
            }
            CHECK(threw);
            return;
        }
        slots[current]->expand(new_size);
        current_size = new_size;
        refill();
    }

    // Move-assign view slot 0 into slot 1 (releasing whatever slot 1 held).
    void move_view() {
        if (!views[0].has_value()) {
            return;
        }
        views[1] = std::move(views[0]);
        view_fill[1] = view_fill[0];
        view_size[1] = view_size[0];
        views[0].reset(); // optional stays engaged after move; clear it
    }

    // Move the PageFile between two slots; the destination's previous file
    // is closed by the move-assignment.
    void move_file() {
        const std::size_t target = current ^ 1;
        slots[target] = std::move(slots[current]);
        current = target;
        CHECK(slots[current ^ 1]->is_closed()); // moved-from behaves as closed
    }

    void release_view() {
        for (auto& view : views) {
            if (view.has_value()) {
                view.reset();
                return;
            }
        }
    }

    // Invariants that must hold after every operation.
    void verify() {
        bool any_view = false;
        for (std::size_t i = 0; i < kViewSlots; ++i) {
            if (!views[i].has_value()) {
                continue;
            }
            any_view = true;
            // No dangling: size and content still match the acquired generation.
            CHECK(views[i]->size() == view_size[i]);
            for (const std::byte b : *views[i]) {
                CHECK(b == view_fill[i]);
            }
        }
        const bool any_open_file =
            (slots[0].has_value() && !slots[0]->is_closed()) ||
            (slots[1].has_value() && !slots[1]->is_closed());
        if (any_view || any_open_file) {
            CHECK(mapper->live() >= 1); // nothing unmapped while still referenced
        } else {
            CHECK(mapper->live() == 0); // everything released exactly on time
        }
        CHECK(mapper->unmap_calls() <= mapper->map_calls());
    }

    // Tear down and require full release: every map was eventually unmapped.
    void finish() {
        for (auto& view : views) {
            view.reset();
        }
        slots[0].reset();
        slots[1].reset();
        CHECK(mapper->live() == 0);
        CHECK(mapper->map_calls() == mapper->unmap_calls());
    }

    std::shared_ptr<CountingMapper> mapper = std::make_shared<CountingMapper>();
    std::array<std::optional<PageFile>, 2> slots;
    std::array<std::optional<PageFile::View>, kViewSlots> views;
    std::array<std::byte, kViewSlots> view_fill{};
    std::array<std::size_t, kViewSlots> view_size{};
    std::size_t current = 0;
    std::size_t current_size = kInitialSize;
    std::byte current_fill{};
    std::byte next_fill{1};
};

using Op = void (Harness::*)();
constexpr std::array<Op, 6> kOps = {&Harness::acquire,   &Harness::close,
                                    &Harness::expand,    &Harness::move_view,
                                    &Harness::move_file, &Harness::release_view};

} // namespace

int main() {
    constexpr int kLength = 6;
    constexpr int kBase = static_cast<int>(kOps.size());

    int sequences = 0;
    for (int code = 0;; ++code) {
        int remainder = code;
        std::array<int, kLength> indices{};
        for (int pos = 0; pos < kLength; ++pos) {
            indices[pos] = remainder % kBase;
            remainder /= kBase;
        }
        if (remainder != 0) {
            break; // enumerated all kBase^kLength sequences
        }

        Harness harness;
        for (const int index : indices) {
            (harness.*kOps[static_cast<std::size_t>(index)])();
            harness.verify();
        }
        harness.finish();
        ++sequences;
    }

    std::printf("enumerated %d interleavings of %d ops (length %d)\n", sequences,
                kBase, kLength);
    CHECK(sequences == 46656); // 6^6
    return test::summarize("interleaving_test");
}
