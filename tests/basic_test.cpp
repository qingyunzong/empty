#include "check.hpp"
#include "counting_mapper.hpp"

#include <optional>

using pagefile::PageFile;

namespace {

bool all_bytes_equal(const PageFile::View& view, std::byte expected) {
    for (const std::byte b : view) {
        if (b != expected) {
            return false;
        }
    }
    return true;
}

// Closing with no outstanding views unmaps immediately.
void close_without_views_unmaps() {
    auto mapper = std::make_shared<CountingMapper>();
    {
        PageFile file(mapper, 128);
        CHECK(mapper->live() == 1);
        file.close();
        CHECK(mapper->live() == 0);
        CHECK(mapper->unmap_calls() == 1);
    }
    CHECK(mapper->live() == 0);
}

// Closing with an outstanding view defers unmap until the view is released.
void unmap_deferred_until_last_view_released() {
    auto mapper = std::make_shared<CountingMapper>();
    std::optional<PageFile::View> view;
    {
        PageFile file(mapper, 256);
        file.fill(std::byte{0xAB});
        view = file.acquire();
        CHECK(view.has_value());
        file.close();
        CHECK(mapper->live() == 1); // view keeps the mapping alive
        CHECK(all_bytes_equal(*view, std::byte{0xAB}));
    } // file destructs; view still alive
    CHECK(mapper->live() == 1);
    CHECK(all_bytes_equal(*view, std::byte{0xAB}));
    view.reset();
    CHECK(mapper->live() == 0);
    CHECK(mapper->map_calls() == mapper->unmap_calls());
}

// After close, acquire returns nullopt; close is idempotent.
void close_rejects_new_views() {
    auto mapper = std::make_shared<CountingMapper>();
    PageFile file(mapper, 64);
    CHECK(file.acquire().has_value());
    file.close();
    CHECK(file.is_closed());
    CHECK(!file.acquire().has_value());
    file.close(); // idempotent
    CHECK(mapper->unmap_calls() == 1);
}

// expand() copies content into a new mapping; old views keep the old one.
void expand_keeps_old_views_valid() {
    auto mapper = std::make_shared<CountingMapper>();
    PageFile file(mapper, 100);
    file.fill(std::byte{0x11});

    auto old_view = file.acquire();
    CHECK(old_view->size() == 100);

    file.expand(400);
    CHECK(mapper->live() == 2); // old mapping still held by old_view
    CHECK(old_view->size() == 100);
    CHECK(all_bytes_equal(*old_view, std::byte{0x11}));

    auto new_view = file.acquire();
    CHECK(new_view->size() == 400);
    for (std::size_t i = 0; i < 100; ++i) { // old content preserved as prefix
        CHECK((*new_view)[i] == std::byte{0x11});
    }

    file.fill(std::byte{0x22}); // mutate current generation only
    CHECK(all_bytes_equal(*old_view, std::byte{0x11}));
    CHECK(all_bytes_equal(*new_view, std::byte{0x22}));

    old_view.reset();
    CHECK(mapper->live() == 1);
    file.close();
    CHECK(mapper->live() == 1); // new_view still holds the current mapping
    new_view.reset();
    CHECK(mapper->live() == 0);
}

// Moving a PageFile transfers ownership; moved-from object behaves as closed.
void move_transfers_ownership() {
    auto mapper = std::make_shared<CountingMapper>();
    PageFile first(mapper, 64);
    first.fill(std::byte{0x07});
    auto view = first.acquire();

    PageFile second(std::move(first));
    CHECK(first.is_closed());
    CHECK(!first.acquire().has_value());
    CHECK(!second.is_closed());

    auto view2 = second.acquire();
    CHECK(view2.has_value());
    CHECK(all_bytes_equal(*view2, std::byte{0x07}));

    PageFile third(mapper, 16);
    third = std::move(second); // move-assign closes third's previous mapping
    CHECK(second.is_closed());
    CHECK(!third.is_closed());
    CHECK(third.acquire().has_value());

    third.close();
    CHECK(mapper->live() == 1); // `view` from the first generation survives
    view.reset();
    view2.reset();
    CHECK(mapper->live() == 0);
    CHECK(mapper->map_calls() == mapper->unmap_calls());
}

// View copies share the mapping; the mapping dies with the last copy.
void view_copies_extend_lifetime() {
    auto mapper = std::make_shared<CountingMapper>();
    PageFile file(mapper, 32);
    auto v1 = file.acquire();
    auto v2 = v1;
    PageFile::View v3 = std::move(*v1);
    CHECK(!*v1);
    file.close();
    CHECK(mapper->live() == 1);
    v2.reset();
    CHECK(mapper->live() == 1);
    v3 = PageFile::View{};
    CHECK(mapper->live() == 0);
}

// expand() on a closed file throws; shrink is rejected.
void expand_errors() {
    auto mapper = std::make_shared<CountingMapper>();
    PageFile file(mapper, 128);
    bool threw = false;
    try {
        file.expand(64);
    } catch (const std::invalid_argument&) {
        threw = true;
    }
    CHECK(threw);
    CHECK(file.size() == 128);

    file.close();
    threw = false;
    try {
        file.expand(256);
    } catch (const std::logic_error&) {
        threw = true;
    }
    CHECK(threw);
    CHECK(mapper->unmap_calls() == 1);
}

} // namespace

int main() {
    close_without_views_unmaps();
    unmap_deferred_until_last_view_released();
    close_rejects_new_views();
    expand_keeps_old_views_valid();
    move_transfers_ownership();
    view_copies_extend_lifetime();
    expand_errors();
    return test::summarize("basic_test");
}
