#include "dlks_formal.hpp"

#include <cinttypes>
#include <cstdio>
#include <cstdlib>
#include <map>
#include <random>
#include <set>
#include <vector>

namespace {

using dlks_formal::PagedCache;
using SeqId = PagedCache::SeqId;
using Token = PagedCache::Token;

#define CHECK(cond)                                                            \
  do {                                                                         \
    if (!(cond)) {                                                             \
      std::fprintf(stderr, "CHECK failed %s:%d: %s\n", __FILE__, __LINE__,     \
                   #cond);                                                     \
      std::abort();                                                            \
    }                                                                          \
  } while (0)

// Naive reference model: each sequence is just a flat vector of tokens.
using NaiveModel = std::map<SeqId, std::vector<Token>>;

// Cross-checks the paged cache against the naive model:
//  - internal conservation invariants hold,
//  - live sequence sets match exactly,
//  - every sequence's tokens read back identically,
//  - each sequence's block table has the naive ceil(len/bs) size,
//  - free_block_count() == num_blocks - distinct referenced blocks.
void verify(const PagedCache& cache, const NaiveModel& model) {
  CHECK(cache.check_invariants());
  const auto ids = cache.sequence_ids();
  CHECK(ids.size() == model.size());
  std::set<PagedCache::BlockId> used;
  const std::uint32_t bs = cache.block_size();
  for (const auto& [seq, tokens] : model) {
    CHECK(cache.has_sequence(seq));
    CHECK(cache.length(seq) == tokens.size());
    const auto& table = cache.block_table(seq);
    CHECK(table.size() == (tokens.size() + bs - 1) / bs);
    for (auto b : table)
      used.insert(b);
    for (std::uint32_t i = 0; i < tokens.size(); ++i)
      CHECK(cache.get(seq, i) == tokens[i]);
  }
  for (SeqId id : ids)
    CHECK(model.count(id) == 1);
  CHECK(cache.free_block_count() ==
        cache.num_blocks() - static_cast<std::uint32_t>(used.size()));
}

// ---------------------------------------------------------------------------
// Targeted unit tests
// ---------------------------------------------------------------------------

void test_basic_append_across_blocks() {
  PagedCache cache(4, 2);
  cache.create_sequence(0);
  for (Token t = 0; t < 5; ++t)
    cache.append(0, t + 100);
  CHECK(cache.length(0) == 5);
  CHECK(cache.block_table(0).size() == 3);
  CHECK(cache.free_block_count() == 1);
  for (Token t = 0; t < 5; ++t)
    CHECK(cache.get(0, t) == t + 100);
  CHECK(cache.check_invariants());
}

void test_fork_shares_then_cow() {
  PagedCache cache(8, 2);
  cache.create_sequence(0);
  for (Token t = 0; t < 3; ++t)
    cache.append(0, t + 10); // blocks: [10,11] [12,_]
  const auto parent_tail = cache.block_table(0).back();
  cache.fork_sequence(0, 1);
  CHECK(cache.free_block_count() == 6); // fork allocates nothing
  CHECK(cache.refcount(parent_tail) == 2);

  cache.append(1, 99); // CoW on the shared tail block
  CHECK(cache.refcount(parent_tail) == 1);
  CHECK(cache.block_table(1).back() != parent_tail);
  CHECK(cache.get(0, 2) == 12); // parent untouched
  CHECK(cache.get(1, 0) == 10 && cache.get(1, 1) == 11);
  CHECK(cache.get(1, 2) == 12 && cache.get(1, 3) == 99);
  CHECK(cache.check_invariants());

  cache.free_sequence(0); // shared prefix survives the parent's release
  CHECK(cache.get(1, 0) == 10 && cache.get(1, 1) == 11);
  CHECK(cache.check_invariants());
  cache.free_sequence(1);
  CHECK(cache.free_block_count() == 8); // everything returned, no leaks
}

void test_set_cow_on_shared_middle_block() {
  PagedCache cache(8, 2);
  cache.create_sequence(0);
  for (Token t = 0; t < 4; ++t)
    cache.append(0, t + 20); // blocks: [20,21] [22,23]
  cache.fork_sequence(0, 1);
  const auto first = cache.block_table(0)[0];
  cache.set(1, 1, 77); // writes into the shared first block
  CHECK(cache.block_table(1)[0] != first);
  CHECK(cache.refcount(first) == 1);
  CHECK(cache.get(0, 1) == 21);
  CHECK(cache.get(1, 0) == 20 && cache.get(1, 1) == 77);
  CHECK(cache.check_invariants());
}

void test_out_of_blocks() {
  PagedCache cache(2, 2);
  cache.create_sequence(0);
  cache.append(0, 1);
  cache.append(0, 2);
  cache.append(0, 3);
  cache.append(0, 4);
  CHECK(!cache.can_append(0));
  bool threw = false;
  try {
    cache.append(0, 5);
  } catch (const std::runtime_error&) {
    threw = true;
  }
  CHECK(threw);
  CHECK(cache.check_invariants());
}

// ---------------------------------------------------------------------------
// Exhaustive exploration of small fork/free/append/set interleavings
// ---------------------------------------------------------------------------

struct ExhaustiveConfig {
  std::uint32_t num_blocks;
  std::uint32_t block_size;
  std::uint32_t max_len;
  std::uint32_t max_live;
  std::uint32_t max_depth;
  std::vector<SeqId> slots;
};

struct Exhaustive {
  explicit Exhaustive(ExhaustiveConfig cfg) : cfg(std::move(cfg)) {}

  ExhaustiveConfig cfg;
  Token next_token = 1; // globally unique tokens maximize aliasing detection
  std::uint64_t nodes = 0;

  std::uint64_t run() {
    PagedCache cache(cfg.num_blocks, cfg.block_size);
    NaiveModel model;
    cache.create_sequence(cfg.slots.front());
    model[cfg.slots.front()] = {};
    dfs(cache, model, 0);
    return nodes;
  }

  void dfs(const PagedCache& cache, const NaiveModel& model, std::uint32_t depth) {
    ++nodes;
    verify(cache, model);
    if (depth == cfg.max_depth)
      return;

    std::vector<SeqId> live, free_slots;
    for (SeqId s : cfg.slots)
      (model.count(s) ? live : free_slots).push_back(s);

    // Append one unique token.
    for (SeqId s : live) {
      if (model.at(s).size() >= cfg.max_len || !cache.can_append(s))
        continue;
      auto c = cache;
      auto m = model;
      const Token t = next_token++;
      c.append(s, t);
      m[s].push_back(t);
      dfs(c, m, depth + 1);
    }
    // Overwrite the middle position (exercises copy-on-write on shared blocks).
    for (SeqId s : live) {
      if (model.at(s).empty())
        continue;
      const std::uint32_t pos =
          static_cast<std::uint32_t>(model.at(s).size() / 2);
      if (!cache.can_set(s, pos))
        continue;
      auto c = cache;
      auto m = model;
      const Token t = next_token++;
      c.set(s, pos, t);
      m[s][pos] = t;
      dfs(c, m, depth + 1);
    }
    // Fork a live sequence into a free slot (beam-style branching).
    if (live.size() < cfg.max_live) {
      for (SeqId src : live) {
        for (SeqId dst : free_slots) {
          auto c = cache;
          auto m = model;
          c.fork_sequence(src, dst);
          m[dst] = m[src];
          dfs(c, m, depth + 1);
        }
      }
    }
    // Release a sequence.
    for (SeqId s : live) {
      auto c = cache;
      auto m = model;
      c.free_sequence(s);
      m.erase(s);
      dfs(c, m, depth + 1);
    }
    // Create a fresh empty sequence in a free slot.
    for (SeqId s : free_slots) {
      if (live.size() >= cfg.max_live)
        break;
      auto c = cache;
      auto m = model;
      c.create_sequence(s);
      m[s] = {};
      dfs(c, m, depth + 1);
    }
  }
};

void test_exhaustive() {
  const std::vector<ExhaustiveConfig> configs = {
      // 3 slots, at most 2 live, block size 2.
      {8, 2, 4, 2, 9, {0, 1, 2}},
      // 3 slots, up to 3 live, block size 3.
      {12, 3, 6, 3, 7, {0, 1, 2}},
      // 2 slots, block size 1 (every token its own block).
      {6, 1, 5, 2, 10, {0, 1}},
  };
  for (const auto& cfg : configs) {
    Exhaustive e(cfg);
    const auto nodes = e.run();
    std::printf("exhaustive bs=%u depth=%u: %" PRIu64 " states verified\n",
                cfg.block_size, cfg.max_depth, nodes);
  }
}

// ---------------------------------------------------------------------------
// Randomized fuzzing against the naive model
// ---------------------------------------------------------------------------

void test_fuzz() {
  constexpr std::uint32_t kSeeds = 300;
  constexpr std::uint32_t kOps = 400;
  constexpr std::uint32_t kSlots = 6;
  Token next_token = 1;
  for (std::uint32_t seed = 0; seed < kSeeds; ++seed) {
    std::mt19937 rng(seed);
    PagedCache cache(24, 4);
    NaiveModel model;
    cache.create_sequence(0);
    model[0] = {};
    for (std::uint32_t op = 0; op < kOps; ++op) {
      std::vector<SeqId> live, free_slots;
      for (SeqId s = 0; s < kSlots; ++s)
        (model.count(s) ? live : free_slots).push_back(s);
      const std::uint32_t choice = rng() % 100;
      if (choice < 40 && !live.empty()) {
        SeqId s = live[rng() % live.size()];
        if (model[s].size() < 24 && cache.can_append(s)) {
          const Token t = next_token++;
          cache.append(s, t);
          model[s].push_back(t);
        }
      } else if (choice < 55 && !live.empty()) {
        SeqId s = live[rng() % live.size()];
        if (!model[s].empty()) {
          const std::uint32_t pos = rng() % model[s].size();
          if (cache.can_set(s, pos)) {
            const Token t = next_token++;
            cache.set(s, pos, t);
            model[s][pos] = t;
          }
        }
      } else if (choice < 80 && !live.empty() && !free_slots.empty()) {
        SeqId src = live[rng() % live.size()];
        SeqId dst = free_slots[rng() % free_slots.size()];
        cache.fork_sequence(src, dst);
        model[dst] = model[src];
      } else if (choice < 95 && !live.empty()) {
        SeqId s = live[rng() % live.size()];
        cache.free_sequence(s);
        model.erase(s);
      } else if (!free_slots.empty()) {
        SeqId s = free_slots[rng() % free_slots.size()];
        cache.create_sequence(s);
        model[s] = {};
      }
      if (op % 16 == 0)
        verify(cache, model);
    }
    verify(cache, model);
  }
  std::printf("fuzz: %u seeds x %u ops verified\n", kSeeds, kOps);
}

// ---------------------------------------------------------------------------
// Beam search: expansion and release interleaved, no double occupancy
// ---------------------------------------------------------------------------

void test_beam_interleaved() {
  constexpr std::uint32_t kBlocks = 64;
  constexpr std::uint32_t kBlockSize = 4;
  constexpr std::uint32_t kBeamWidth = 3;
  constexpr std::uint32_t kRounds = 8;
  Token next_token = 1;

  PagedCache cache(kBlocks, kBlockSize);
  NaiveModel model;
  cache.create_sequence(0);
  model[0] = {};
  for (int i = 0; i < 3; ++i) {
    cache.append(0, next_token);
    model[0].push_back(next_token++);
  }
  verify(cache, model);

  SeqId next_id = 1;
  std::vector<SeqId> frontier = {0};
  for (std::uint32_t round = 0; round < kRounds; ++round) {
    std::vector<SeqId> next_frontier;
    for (std::uint32_t i = 0; i < frontier.size(); ++i) {
      const SeqId parent = frontier[i];
      // Expand: every child shares the parent's prefix blocks.
      std::vector<SeqId> children;
      for (std::uint32_t k = 0; k < kBeamWidth; ++k)
        children.push_back(next_id++);
      cache.beam_expand(parent, children);
      for (SeqId c : children)
        model[c] = model[parent];
      verify(cache, model);

      // Children extend their private tails (copy-on-write on shared blocks).
      for (SeqId c : children) {
        if (!cache.can_append(c))
          continue;
        const Token t = next_token++;
        cache.append(c, t);
        model[c].push_back(t);
      }
      verify(cache, model);

      // Interleaved release: retire every other parent right after expansion.
      if (i % 2 == 0) {
        cache.free_sequence(parent);
        model.erase(parent);
        verify(cache, model);
      } else {
        next_frontier.push_back(parent);
      }
      // Keep the first child of each parent as the next beam parent.
      next_frontier.push_back(children.front());
      // Release the remaining children to keep the population bounded.
      for (std::size_t k = 1; k < children.size(); ++k) {
        cache.free_sequence(children[k]);
        model.erase(children[k]);
      }
      verify(cache, model);
    }
    frontier = std::move(next_frontier);
    // Bound the frontier so the fixed pool suffices for all rounds.
    while (frontier.size() > 4) {
      SeqId victim = frontier.back();
      frontier.pop_back();
      cache.free_sequence(victim);
      model.erase(victim);
      verify(cache, model);
    }
  }

  // Drain everything: all blocks must return to the free list exactly once.
  for (SeqId s : cache.sequence_ids()) {
    cache.free_sequence(s);
    model.erase(s);
  }
  CHECK(cache.free_block_count() == kBlocks);
  CHECK(cache.check_invariants());
  std::printf("beam interleaved: %u rounds verified, pool fully reclaimed\n",
              kRounds);
}

} // namespace

int main() {
  test_basic_append_across_blocks();
  test_fork_shares_then_cow();
  test_set_cow_on_shared_middle_block();
  test_out_of_blocks();
  test_exhaustive();
  test_fuzz();
  test_beam_interleaved();
  std::printf("all paged cache tests passed\n");
  return 0;
}
