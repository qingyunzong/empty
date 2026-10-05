# graphser

Deterministic object-graph serialization for C++20 (header-only, standard
library only). Preserves object sharing and reference cycles; assigns
stable object IDs by first-visit order from the root in field order —
never by pointer address.

## Layout

- `include/graphser/graphser.hpp` — the whole library (header-only)
- `tests/graph_test_util.hpp` — shared fixtures: node types, random cyclic
  graph generator, aliasing-aware isomorphism checker
- `tests/test_stable_ids.cpp` — ID assignment order & determinism
- `tests/test_roundtrip.cpp` — random cyclic graph round-trips
- `tests/test_failure.cpp` — failure injection & leak checks
- `CMakeLists.txt` — CMake/CTest build

## Design

**Stable IDs.** Serialization runs a pre-order DFS from the root,
recursing into reference fields in the exact order `write_fields()` emits
them (`NumberingWriter`). The first visit of each object assigns the next
ID (0, 1, 2, …). The traversal only ever asks "have we seen this object",
so IDs depend solely on graph shape and field order — two logically
identical graphs built at different addresses serialize to identical
bytes.

**Sharing & cycles.** References are serialized as 32-bit object IDs
(`0xFFFFFFFF` = null). Deserialization first creates all objects from the
tag table, then populates fields, so back-references and cycles resolve
naturally and aliasing is preserved exactly.

**Exception safety.** If deserialization throws (unknown type, throwing
factory, throwing `read_fields`, corrupt data), the catch block calls
`break_cycles()` on every partially constructed object and releases the
object vector — nothing leaks, even when reference cycles were already
formed. Unknown type tags are rejected with `unknown_type_error` by the
`TypeRegistry`.

**User contract.** A serializable type derives from
`graphser::Serializable` and implements:

```cpp
struct Node : graphser::Serializable {
  std::int64_t value = 0;
  std::shared_ptr<Node> left, right;

  std::string_view type_tag() const noexcept override { return "node"; }
  void write_fields(graphser::FieldWriter& w) const override {
    w.i64(value); w.ref(left); w.ref(right);
  }
  void read_fields(graphser::FieldReader& r) override {
    value = r.i64(); r.ref(left); r.ref(right);
  }
  void break_cycles() noexcept override { left.reset(); right.reset(); }
};

graphser::TypeRegistry reg;
reg.register_type<Node>("node");

auto bytes = graphser::serialize(root);
auto copy  = graphser::deserialize(bytes, reg);
```

## Wire format (little-endian)

```
magic    4B   "GSER"
version  1B   currently 1
count    u32  number of objects
tags     count x (u16 length + bytes)   tag table, in ID order
fields   per-object field data, in ID order (layout defined by each type;
         references are u32 IDs, 0xFFFFFFFF = null)
root     u32  root object ID (always 0 for graphs produced by serialize())
```

## Tests (CMake/CTest)

```
cmake -S . -B build -DCMAKE_BUILD_TYPE=Debug
cmake --build build -j
cd build && ctest --output-on-failure
```

Tests are built with `-fsanitize=address,undefined`. LeakSanitizer is
disabled at runtime (`ASAN_OPTIONS=detect_leaks=0` via a CTest property)
because it cannot run under ptrace-restricted sandboxes; leak detection is
instead covered explicitly by (a) live-instance counters on the test node
classes and (b) global `operator new`/`operator delete` balance counting
in `test_failure.cpp`.

- **test_stable_ids** — hand-built graph with sharing + a cycle; asserts
  the serialized tag table is exactly `[pair, pair, leaf, list]` (field-order
  pre-order DFS), that two independently built identical graphs produce
  identical bytes, that re-serialization is deterministic, and that null
  refs, sharing and cycles survive a round-trip.
- **test_roundtrip** — 280 random cyclic graphs (40 seeds x sizes
  1/2/3/5/10/40/150, ~15% null refs, 3 node types). Each is serialized,
  deserialized, and checked with an aliasing-aware isomorphism walk:
  identical data, identical reachable-object count, and identical aliasing
  (a node revisited on one side must map to the *same* node on the other).
- **test_failure** — 8 cases: unknown tag (expects `unknown_type_error`),
  factory throwing on 2nd construction, `read_fields` throwing after a
  cycle was formed, truncated buffer, out-of-range reference ID, absurd
  object count, trailing garbage, bad magic/version. After all cases:
  live-instance count and global allocation balance must equal their
  baselines (no leaks).

## Actual test results

Recorded 2026-10-05, g++ 15.2.0, CMake 4.2.3, Debug + ASan/UBSan:

```
1/3 Test #1: test_stable_ids ..................   Passed    0.01 sec
2/3 Test #2: test_roundtrip ...................   Passed    0.31 sec
3/3 Test #3: test_failure .....................   Passed    0.03 sec
100% tests passed, 0 tests failed out of 3
```

Test stdout: `test_stable_ids: OK` / `test_roundtrip: OK (280 random
graphs)` / `test_failure: OK (8 failure cases, no leaks)`.

A negative check was also performed: with the `break_cycles()` cleanup
temporarily removed from `deserialize()`, `test_failure` fails at its
live-instance assertion — confirming the leak checks have teeth.
