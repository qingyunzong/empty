// Cancellation: cancel() releases every cursor exactly once, is
// idempotent, works from any state, and the destructor never re-closes.
#include "model.hpp"

namespace {

using Counters = std::vector<std::shared_ptr<int>>;

// Close counts outlive the sources (and the merger), so exactly-once
// close stays observable after destruction.
Counters counters_of(const std::vector<ControlledSource*>& handles) {
    Counters counters;
    for (const auto* source : handles) {
        counters.push_back(source->close_counter());
    }
    return counters;
}

void expect_all_closed_once(const Counters& counters) {
    for (const auto& counter : counters) {
        CHECK(*counter == 1);
    }
}

} // namespace

static void test_cancel_before_any_read() {
    std::vector<ControlledSource*> handles;
    Counters counters;
    {
        auto merger = make_merger({{1, 2}, {3, 4}, {5, 6}}, handles);
        counters = counters_of(handles);
        merger->cancel();
        expect_all_closed_once(counters);
        CHECK(merger->next().status == kway::Status::Done);
        merger->cancel(); // idempotent
        expect_all_closed_once(counters);
    } // destructor must not double-close
    expect_all_closed_once(counters);
}

static void test_cancel_mid_stream() {
    const std::vector<std::vector<int>> arrays = {
        {1, 4, 7},
        {2, 5, 8},
        {3, 6, 9},
    };
    std::vector<ControlledSource*> handles;
    Counters counters;
    {
        auto merger = make_merger(arrays, handles);
        counters = counters_of(handles);
        for (int i = 0; i < 4; ++i) {
            CHECK(merger->next().status == kway::Status::Ok);
        }
        merger->cancel();
        expect_all_closed_once(counters);
        CHECK(merger->next().status == kway::Status::Done);
        merger->cancel();
        merger->cancel();
        expect_all_closed_once(counters);
    }
    expect_all_closed_once(counters);
}

static void test_cancel_while_paused() {
    std::vector<ControlledSource*> handles;
    Counters counters;
    {
        auto merger = make_merger({{1}, {2}}, handles);
        counters = counters_of(handles);
        merger->pause();
        CHECK(merger->next().status == kway::Status::Paused);
        merger->cancel();
        expect_all_closed_once(counters);
        merger->resume(); // cancel wins over resume
        CHECK(merger->next().status == kway::Status::Done);
    }
    expect_all_closed_once(counters);
}

static void test_destructor_releases_without_cancel() {
    std::vector<ControlledSource*> handles;
    Counters counters;
    {
        auto merger = make_merger({{1, 2, 3}, {4, 5, 6}}, handles);
        counters = counters_of(handles);
        CHECK(merger->next().status == kway::Status::Ok);
    } // destructor closes everything exactly once
    expect_all_closed_once(counters);
}

static void test_cancel_after_done() {
    std::vector<ControlledSource*> handles;
    Counters counters;
    {
        auto merger = make_merger({{1}, {2}}, handles);
        counters = counters_of(handles);
        CHECK(merger->next().status == kway::Status::Ok);
        CHECK(merger->next().status == kway::Status::Ok);
        CHECK(merger->next().status == kway::Status::Done);
        expect_all_closed_once(counters); // exhausted sources already closed
        merger->cancel();
        expect_all_closed_once(counters);
    }
    expect_all_closed_once(counters);
}

int main() {
    test_cancel_before_any_read();
    test_cancel_mid_stream();
    test_cancel_while_paused();
    test_destructor_releases_without_cancel();
    test_cancel_after_done();
    return 0;
}
