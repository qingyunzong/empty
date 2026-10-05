#include "bq/bounded_queue.hpp"

#include <memory>
#include <optional>
#include <string>

#include "check.hpp"

int main() {
    {
        // FIFO order, capacity limit, try_ variants.
        bq::bounded_queue<int> q(3);
        CHECK(q.capacity() == 3);
        CHECK(q.size() == 0);
        CHECK(!q.closed());
        CHECK(q.try_pop() == std::nullopt);

        CHECK(q.push(1));
        CHECK(q.push(2));
        CHECK(q.emplace(3));
        CHECK(q.size() == 3);
        CHECK(!q.try_push(4));  // full

        auto a = q.pop();
        CHECK(a && *a == 1);
        CHECK(q.try_push(4));
        auto b = q.try_pop();
        CHECK(b && *b == 2);
        auto c = q.pop();
        CHECK(c && *c == 3);
        auto d = q.pop();
        CHECK(d && *d == 4);
        CHECK(q.try_pop() == std::nullopt);
        CHECK(q.size() == 0);
    }
    {
        // Move-only element type.
        bq::bounded_queue<std::unique_ptr<int>> q(2);
        CHECK(q.push(std::make_unique<int>(7)));
        auto v = q.pop();
        CHECK(v && *v && **v == 7);
    }
    {
        // In-place construction of a non-trivial type.
        bq::bounded_queue<std::string> q(2);
        CHECK(q.emplace("hello"));
        auto v = q.pop();
        CHECK(v && *v == "hello");
    }
    PASS("test_basic");
}
