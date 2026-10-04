// Test suite for the Rope library. Each test is a CTest case:
//   rope_tests <case-name>
#include <rope/rope.hpp>

#include <cstdlib>
#include <cstring>
#include <iostream>
#include <random>
#include <string>
#include <string_view>
#include <vector>

#define CHECK(cond)                                                          \
  do {                                                                       \
    if (!(cond)) {                                                           \
      std::cerr << "CHECK failed at " << __FILE__ << ':' << __LINE__ << ": " \
                << #cond << '\n';                                            \
      std::exit(1);                                                          \
    }                                                                        \
  } while (0)

using Rope = rope::rope;

// --- reference UTF-8 boundary helpers over a flat std::string ------------
static bool ref_is_boundary(const std::string& s, std::size_t pos) {
  if (pos > s.size()) return false;
  if (pos == 0 || pos == s.size()) return true;
  return (static_cast<unsigned char>(s[pos]) & 0xC0) != 0x80;
}
static std::size_t ref_floor_boundary(const std::string& s, std::size_t pos) {
  if (pos > s.size()) pos = s.size();
  while (pos > 0 && !ref_is_boundary(s, pos)) --pos;
  return pos;
}
static std::size_t ref_ceil_boundary(const std::string& s, std::size_t pos) {
  if (pos > s.size()) pos = s.size();
  while (pos < s.size() && !ref_is_boundary(s, pos)) ++pos;
  return pos;
}

// Random string mixing ASCII and 2/3/4-byte UTF-8 codepoints.
static std::string rand_text(std::mt19937_64& rng, std::size_t max_len) {
  static const std::string pool[] = {
      "a", "Z", "0", " ", "\n", "\xC3\xA9", "\xC2\xA3",
      "\xE4\xB8\xAD", "\xE6\x96\x87", "\xE2\x82\xAC",
      "\xF0\x9F\x98\x80", "\xF0\x9F\x9A\x80"};
  std::string s;
  const std::size_t target = rng() % (max_len + 1);
  while (s.size() < target) s += pool[rng() % std::size(pool)];
  return s;
}

// Build a Rope from `s` split at arbitrary byte offsets (possibly
// mid-codepoint), to prove splits never affect boundary queries.
static Rope rand_split_rope(std::mt19937_64& rng, const std::string& s) {
  Rope r;
  std::size_t pos = 0;
  while (pos < s.size()) {
    const std::size_t n = 1 + rng() % 37;
    const std::size_t take = pos + n > s.size() ? s.size() - pos : n;
    r = r.concat(Rope::from(std::string_view(s).substr(pos, take)));
    pos += take;
  }
  return r;
}

static void check_boundaries_against(const Rope& r, const std::string& s) {
  CHECK(r.size() == s.size());
  for (std::size_t p = 0; p <= s.size() + 1; ++p) {
    CHECK(r.is_char_boundary(p) == ref_is_boundary(s, p));
    CHECK(r.floor_char_boundary(p) == ref_floor_boundary(s, p));
    CHECK(r.ceil_char_boundary(p) == ref_ceil_boundary(s, p));
  }
}

// -------------------------------------------------------------------------
static void test_basic() {
  Rope a = Rope::from("hello");
  Rope b = Rope::from(" ");
  Rope c = Rope::from("world");
  Rope abc = a.concat(b).concat(c);
  CHECK(abc.size() == 11);
  CHECK(abc.to_string() == "hello world");
  CHECK(abc[0] == 'h' && abc[10] == 'd');

  CHECK(abc.slice(0, 5).to_string() == "hello");
  CHECK(abc.slice(6, 5).to_string() == "world");
  CHECK(abc.slice(3, 4).to_string() == "lo w");
  CHECK(abc.slice(0, 0).empty());
  CHECK(abc.slice(11, 0).empty());

  CHECK(abc.replace(6, 5, "rust").to_string() == "hello rust");
  CHECK(abc.replace(0, 0, ">> ").to_string() == ">> hello world");
  CHECK(abc.replace(11, 0, "!").to_string() == "hello world!");
  CHECK(abc.replace(0, 11, "gone").to_string() == "gone");
  CHECK(abc.replace(3, 0, "XX").to_string() == "helXXlo world");

  // out-of-range checks
  bool threw = false;
  try { abc.slice(12, 1); } catch (const std::out_of_range&) { threw = true; }
  CHECK(threw);
  threw = false;
  try { abc.slice(10, 2); } catch (const std::out_of_range&) { threw = true; }
  CHECK(threw);
  threw = false;
  try { abc.replace(10, 2, "x"); } catch (const std::out_of_range&) { threw = true; }
  CHECK(threw);
  threw = false;
  try { (void)abc[11]; } catch (const std::out_of_range&) { threw = true; }
  CHECK(threw);

  // empty ropes
  Rope e;
  CHECK(e.empty() && e.size() == 0 && e.to_string().empty());
  CHECK(e.concat(abc).to_string() == "hello world");
  CHECK(abc.concat(e).to_string() == "hello world");

  // large input is chunked and reassembled correctly
  std::string big(100000, 'x');
  for (std::size_t i = 0; i < big.size(); i += 997) big[i] = char('a' + i % 26);
  CHECK(Rope::from(big).to_string() == big);
  CHECK(Rope::from(big).size() == big.size());
}

// Old views must survive derivation unchanged (persistence).
static void test_persistence() {
  Rope base = Rope::from("hello world");
  Rope v2 = base.replace(6, 5, "rust");
  Rope v3 = v2.slice(0, 5);
  Rope v4 = v2.concat(Rope::from("!!!"));
  Rope v5 = v4.replace(0, 2, "HE");

  CHECK(base.to_string() == "hello world");
  CHECK(v2.to_string() == "hello rust");
  CHECK(v3.to_string() == "hello");
  CHECK(v4.to_string() == "hello rust!!!");
  CHECK(v5.to_string() == "HEllo rust!!!");

  // Deriving again from an old view still works and changes nothing.
  Rope v6 = base.replace(0, 5, "goodbye");
  CHECK(v6.to_string() == "goodbye world");
  CHECK(base.to_string() == "hello world");
  CHECK(v2.to_string() == "hello rust");
  CHECK(v5.to_string() == "HEllo rust!!!");
}

// Arbitrary splits (including mid-codepoint) must not affect UTF-8
// boundary queries.
static void test_utf8_boundaries() {
  std::mt19937_64 rng(20261005);
  for (int iter = 0; iter < 200; ++iter) {
    const std::string s = rand_text(rng, 400);
    const Rope r = rand_split_rope(rng, s);
    CHECK(r.to_string() == s);
    check_boundaries_against(r, s);
  }
  // A Rope built by slicing straight through codepoints.
  const std::string s = "a\xC3\xA9\xE4\xB8\xAD\xF0\x9F\x98\x80z";
  const Rope full = Rope::from(s);
  for (std::size_t p = 0; p <= s.size(); ++p)
    for (std::size_t q = p; q <= s.size(); ++q) {
      const Rope sub = full.slice(p, q - p);
      check_boundaries_against(sub, s.substr(p, q - p));
    }
}

// Random operation fuzz against a std::string oracle.
static void test_random_fuzz() {
  std::mt19937_64 rng(0x5eed5eed);
  Rope r;
  std::string model;
  for (int step = 0; step < 4000; ++step) {
    const int op = static_cast<int>(rng() % 100);
    if (op < 30) { // insert
      const std::string t = rand_text(rng, 48);
      const std::size_t pos = model.empty() ? 0 : rng() % (model.size() + 1);
      r = r.replace(pos, 0, t);
      model.insert(pos, t);
    } else if (op < 50) { // erase
      if (model.empty()) continue;
      const std::size_t pos = rng() % model.size();
      const std::size_t len = rng() % (model.size() - pos + 1);
      r = r.replace(pos, len, "");
      model.erase(pos, len);
    } else if (op < 70) { // replace
      if (model.empty()) continue;
      const std::size_t pos = rng() % model.size();
      const std::size_t len = rng() % (model.size() - pos + 1);
      const std::string t = rand_text(rng, 48);
      r = r.replace(pos, len, t);
      model.replace(pos, len, t);
    } else if (op < 82) { // slice: keep a subrange as the new Rope
      if (model.empty()) continue;
      const std::size_t pos = rng() % model.size();
      const std::size_t len = rng() % (model.size() - pos + 1);
      r = r.slice(pos, len);
      model = model.substr(pos, len);
    } else if (op < 92) { // concat
      const std::string t = rand_text(rng, 64);
      r = r.concat(Rope::from(t));
      model += t;
    } else { // boundary spot-checks at arbitrary (possibly mid-char) offsets
      for (int k = 0; k < 8 && !model.empty(); ++k) {
        const std::size_t p = rng() % (model.size() + 1);
        CHECK(r.is_char_boundary(p) == ref_is_boundary(model, p));
        CHECK(r.floor_char_boundary(p) == ref_floor_boundary(model, p));
        CHECK(r.ceil_char_boundary(p) == ref_ceil_boundary(model, p));
      }
    }
    CHECK(r.size() == model.size());
    CHECK(r.depth() < 256); // rebalancing keeps the tree shallow
    if (step % 97 == 0) CHECK(r.to_string() == model);
  }
  CHECK(r.to_string() == model);
  check_boundaries_against(r, model);
}

// Node sharing and reclamation safety, observed via weak_ptr handles.
static void test_lifetime() {
  using rope::detail::node;

  // A derived Rope keeps shared ancestors alive; dropping every view
  // reclaims them.
  std::weak_ptr<const node> root_a, root_b, root_c;
  {
    Rope a = Rope::from("hello");
    root_a = a.debug_node();
    Rope b = a.concat(Rope::from(" world"));
    root_b = b.debug_node();
    Rope c = b.slice(0, 11);
    root_c = c.debug_node();
    CHECK(!root_a.expired() && !root_b.expired() && !root_c.expired());
    {
      Rope d = std::move(a); // a's node now owned by d as well
      CHECK(!root_a.expired());
    } // d dies; b still shares the node
    CHECK(!root_a.expired());
    CHECK(c.to_string() == "hello world");
  }
  CHECK(root_a.expired());  // no view references it anymore
  CHECK(root_b.expired());
  CHECK(root_c.expired());

  // Slices share the underlying leaf buffer; the buffer outlives the
  // original Rope as long as any slice exists.
  std::weak_ptr<const node> leaf_handle;
  {
    Rope big = Rope::from(std::string(5000, 'q'));
    Rope small = big.slice(100, 50);
    leaf_handle = small.debug_node();
    CHECK(small.to_string() == std::string(50, 'q'));
    big = Rope(); // drop the original
    CHECK(!leaf_handle.expired()); // shared leaf node still alive
    CHECK(small.to_string() == std::string(50, 'q'));
    small = Rope();
  }
  CHECK(leaf_handle.expired());

  // Shared sub-ropes across many views: all stay valid, freed together.
  std::vector<std::weak_ptr<const node>> handles;
  {
    Rope shared = Rope::from("shared-segment");
    std::vector<Rope> views;
    for (int i = 0; i < 50; ++i) {
      Rope v = Rope::from("pre-").concat(shared).concat(Rope::from("-post"));
      views.push_back(v);
      handles.push_back(v.debug_node());
    }
    shared = Rope(); // drop the original handle
    for (auto& v : views)
      CHECK(v.to_string() == "pre-shared-segment-post");
    for (auto& h : handles) CHECK(!h.expired());
  }
  for (auto& h : handles) CHECK(h.expired());
}

// Cached-length overflow protection.
static void test_overflow() {
  using rope::detail::checked_add;
  const std::size_t m = std::numeric_limits<std::size_t>::max();
  CHECK(!checked_add(m, 1).has_value());
  CHECK(!checked_add(m, m).has_value());
  CHECK(!checked_add(m - 1, 2).has_value());
  CHECK(checked_add(m, 0).value() == m);
  CHECK(checked_add(m - 5, 5).value() == m);
  CHECK(checked_add(3, 4).value() == 7);

  // make_concat must route through the checked addition: simulate the
  // failure path by faking a node with a near-max cached length.
  auto fake = std::make_shared<rope::detail::node>();
  fake->kind = rope::detail::node::kind_t::leaf;
  fake->len = m;
  fake->depth = 1;
  bool threw = false;
  try {
    (void)rope::detail::make_concat(fake, fake);
  } catch (const std::length_error&) {
    threw = true;
  }
  CHECK(threw);
}

int main(int argc, char** argv) {
  if (argc != 2) {
    std::cerr << "usage: rope_tests <case>\n";
    return 2;
  }
  const std::string_view name = argv[1];
  if (name == "basic") test_basic();
  else if (name == "persistence") test_persistence();
  else if (name == "utf8_boundaries") test_utf8_boundaries();
  else if (name == "random_fuzz") test_random_fuzz();
  else if (name == "lifetime") test_lifetime();
  else if (name == "overflow") test_overflow();
  else {
    std::cerr << "unknown case: " << name << '\n';
    return 2;
  }
  std::cout << name << ": PASS\n";
  return 0;
}
