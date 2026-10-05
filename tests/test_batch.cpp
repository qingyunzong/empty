#include "rbatch/batch.hpp"

#include <cstdlib>
#include <functional>
#include <iostream>
#include <map>
#include <stdexcept>
#include <string>
#include <type_traits>
#include <vector>

namespace {

int g_failures = 0;

#define CHECK(cond) do { if (!(cond)) { std::cerr << "CHECK failed at " << __FILE__ << ':' << __LINE__ << ": " #cond << std::endl; ++g_failures; } } while (0)

// Records every acquire/release event so tests can verify the full trace.
struct Trace {
    std::vector<std::string> events;

    std::vector<int> releases_of(const std::string& prefix) const {
        std::vector<int> ids;
        for (const auto& e : events) {
            if (e.rfind(prefix, 0) == 0) {
                ids.push_back(std::stoi(e.substr(prefix.size())));
            }
        }
        return ids;
    }

    rbatch::ReleaseFn releaser() {
        return [this](int id) { events.push_back("release:" + std::to_string(id)); };
    }
};

std::string join(const std::vector<int>& v) {
    std::string s = "[";
    for (std::size_t i = 0; i < v.size(); ++i) {
        if (i) s += ",";
        s += std::to_string(v[i]);
    }
    return s + "]";
}

void expect_order(const char* what, const std::vector<int>& got,
                  const std::vector<int>& want) {
    if (got != want) {
        std::cerr << "order mismatch (" << what << "): got " << join(got)
                  << " want " << join(want) << std::endl;
        ++g_failures;
    }
}

// ---------------------------------------------------------------------------

int test_type_traits() {
    static_assert(!std::is_copy_constructible_v<rbatch::Handle>);
    static_assert(!std::is_copy_assignable_v<rbatch::Handle>);
    static_assert(std::is_move_constructible_v<rbatch::Handle>);
    static_assert(std::is_move_assignable_v<rbatch::Handle>);
    static_assert(std::is_nothrow_move_constructible_v<rbatch::Handle>);

    static_assert(!std::is_copy_constructible_v<rbatch::ResourceBatch>);
    static_assert(!std::is_copy_assignable_v<rbatch::ResourceBatch>);
    static_assert(std::is_move_constructible_v<rbatch::ResourceBatch>);
    static_assert(std::is_move_assignable_v<rbatch::ResourceBatch>);
    return 0;
}

// All acquisitions succeed: nothing is released while the batch is alive,
// then destruction releases in reverse acquisition order.
int test_success_release_order() {
    Trace trace;
    {
        auto batch = rbatch::acquire_batch(5, [&](std::size_t i) {
            trace.events.push_back("acquire:" + std::to_string(i));
            return rbatch::Handle(static_cast<int>(i), trace.releaser());
        });
        CHECK(batch.size() == 5);
        CHECK(trace.releases_of("release:").empty());
        CHECK(batch.at(0).id() == 0);
        CHECK(batch.at(4).id() == 4);
    }
    expect_order("success", trace.releases_of("release:"), {4, 3, 2, 1, 0});
    return 0;
}

// The factory fails on the k-th item: handles 0..k-1 must be released in
// reverse order and the original exception must propagate. The release
// callback for id 1 throws on purpose; rollback must still release the rest.
int test_failure_at_k() {
    constexpr std::size_t count = 5;
    for (std::size_t k = 0; k < count; ++k) {
        Trace trace;
        bool threw = false;
        try {
            auto batch = rbatch::acquire_batch(count, [&](std::size_t i) -> rbatch::Handle {
                trace.events.push_back("acquire:" + std::to_string(i));
                if (i == k) {
                    throw std::runtime_error("inject failure at " + std::to_string(i));
                }
                const int id = static_cast<int>(i);
                return rbatch::Handle(id, [&trace, id](int rid) {
                    trace.events.push_back("release:" + std::to_string(rid));
                    if (id == 1) {
                        throw std::runtime_error("release callback throws");
                    }
                });
            });
            (void)batch;
        } catch (const std::runtime_error& e) {
            threw = true;
            CHECK(std::string(e.what()) == "inject failure at " + std::to_string(k));
        }
        CHECK(threw);

        std::vector<int> want;
        for (int i = static_cast<int>(k) - 1; i >= 0; --i) {
            want.push_back(i);
        }
        expect_order(("failure at k=" + std::to_string(k)).c_str(),
                     trace.releases_of("release:"), want);

        std::vector<int> acquired;
        for (std::size_t i = 0; i <= k; ++i) {
            acquired.push_back(static_cast<int>(i));
        }
        expect_order("acquire attempts", trace.releases_of("acquire:"), acquired);
    }
    return 0;
}

// A handle moved through a chain (move-construct + move-assign) releases its
// resource exactly once, when the final owner dies.
int test_move_chain() {
    Trace trace;
    {
        rbatch::Handle h0(7, trace.releaser());
        rbatch::Handle h1(std::move(h0));
        CHECK(!h0.valid());
        CHECK(h1.valid() && h1.id() == 7);

        rbatch::Handle h2(9, trace.releaser());
        h2 = std::move(h1); // move-assign: old resource 9 released once here
        CHECK(!h1.valid());
        CHECK(h2.valid() && h2.id() == 7);
        expect_order("move-assign releases old", trace.releases_of("release:"), {9});

        rbatch::Handle h3(std::move(h2));
        CHECK(!h2.valid());
        CHECK(h3.valid() && h3.id() == 7);
        CHECK(trace.releases_of("release:").size() == 1);
    }
    expect_order("move chain final", trace.releases_of("release:"), {9, 7});

    // Batch move chain: resources survive moves and are released once.
    Trace trace2;
    {
        auto b1 = rbatch::acquire_batch(3, [&](std::size_t i) {
            return rbatch::Handle(static_cast<int>(i), trace2.releaser());
        });
        auto b2 = std::move(b1);
        CHECK(b2.size() == 3);
        rbatch::ResourceBatch b3;
        b3 = std::move(b2);
        CHECK(b3.size() == 3);
        CHECK(trace2.releases_of("release:").empty());
    }
    expect_order("batch move chain", trace2.releases_of("release:"), {2, 1, 0});
    return 0;
}

// A throwing release callback must not prevent the remaining handles from
// being released, and must not terminate the program.
int test_throwing_release() {
    Trace trace;
    {
        auto batch = rbatch::acquire_batch(4, [&](std::size_t i) {
            const int id = static_cast<int>(i);
            return rbatch::Handle(id, [&trace, id](int rid) {
                trace.events.push_back("release:" + std::to_string(rid));
                if (id == 1 || id == 3) {
                    throw std::runtime_error("release failed for " + std::to_string(id));
                }
            });
        });
        batch.release_all(); // must not throw, must release everything
        CHECK(batch.empty());
    }
    expect_order("throwing release", trace.releases_of("release:"), {3, 2, 1, 0});

    // A lone handle whose callback throws still releases once, no terminate.
    Trace trace2;
    {
        rbatch::Handle h(42, [&trace2](int rid) {
            trace2.events.push_back("release:" + std::to_string(rid));
            throw std::runtime_error("boom");
        });
    }
    expect_order("lone throwing dtor", trace2.releases_of("release:"), {42});
    return 0;
}

// release() leaves the handle empty even when the callback throws, so the
// destructor cannot release the resource a second time.
int test_release_once() {
    Trace trace;
    {
        rbatch::Handle h(5, trace.releaser());
        h.release();
        CHECK(!h.valid());
        h.release(); // no-op on empty handle
    }
    expect_order("manual release once", trace.releases_of("release:"), {5});

    Trace trace2;
    {
        rbatch::Handle h(6, [&trace2](int rid) {
            trace2.events.push_back("release:" + std::to_string(rid));
            throw std::runtime_error("boom");
        });
        bool threw = false;
        try {
            h.release();
        } catch (const std::runtime_error&) {
            threw = true;
        }
        CHECK(threw);
        CHECK(!h.valid()); // empty despite the throw: destructor is a no-op
    }
    expect_order("throwing release once", trace2.releases_of("release:"), {6});
    return 0;
}

} // namespace

int main(int argc, char** argv) {
    static const std::map<std::string, std::function<int()>> tests = {
        {"type_traits", test_type_traits},
        {"success_release_order", test_success_release_order},
        {"failure_at_k", test_failure_at_k},
        {"move_chain", test_move_chain},
        {"throwing_release", test_throwing_release},
        {"release_once", test_release_once},
    };

    if (argc != 2 || !tests.count(argv[1])) {
        std::cerr << "usage: " << argv[0] << " <test-name>\navailable:";
        for (const auto& [name, _] : tests) {
            std::cerr << ' ' << name;
        }
        std::cerr << std::endl;
        return 2;
    }

    const int rc = tests.at(argv[1])();
    if (g_failures != 0 || rc != 0) {
        std::cerr << "FAILED: " << argv[1] << " (" << g_failures
                  << " failed checks)" << std::endl;
        return 1;
    }
    std::cout << "PASSED: " << argv[1] << std::endl;
    return 0;
}
