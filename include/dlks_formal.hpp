#pragma once

#include <cstdint>
#include <stdexcept>
#include <unordered_map>
#include <vector>

namespace dlks_formal {

// Embeddable paged sequence cache for inference engines.
//
// Sequences are backed by fixed-size physical blocks drawn from a shared
// pool. Every physical block carries an exact reference count: a block is
// returned to the free list only when its last reference disappears, and a
// free block is never handed out while still referenced. Forked sequences
// (beam search) share their parent's blocks read-only; any write to a
// shared block triggers a copy-on-write so the sharers keep their data.
class PagedCache {
public:
  using SeqId = std::uint32_t;
  using BlockId = std::uint32_t;
  using Token = std::uint64_t;

  PagedCache(std::uint32_t num_blocks, std::uint32_t block_size)
      : num_blocks_(num_blocks),
        block_size_(block_size),
        refcount_(num_blocks, 0),
        data_(static_cast<std::size_t>(num_blocks) * block_size, Token{0}) {
    if (num_blocks == 0 || block_size == 0)
      throw std::invalid_argument("num_blocks and block_size must be positive");
    free_list_.reserve(num_blocks);
    for (std::uint32_t b = num_blocks; b-- > 0;)
      free_list_.push_back(b);
  }

  std::uint32_t num_blocks() const { return num_blocks_; }
  std::uint32_t block_size() const { return block_size_; }
  std::uint32_t free_block_count() const {
    return static_cast<std::uint32_t>(free_list_.size());
  }

  bool has_sequence(SeqId seq) const { return tables_.find(seq) != tables_.end(); }

  std::vector<SeqId> sequence_ids() const {
    std::vector<SeqId> ids;
    ids.reserve(tables_.size());
    for (const auto& [id, st] : tables_)
      ids.push_back(id);
    return ids;
  }

  void create_sequence(SeqId seq) {
    if (has_sequence(seq))
      throw std::invalid_argument("sequence already exists");
    tables_.emplace(seq, SeqState{});
  }

  void free_sequence(SeqId seq) {
    auto& st = state(seq);
    for (BlockId b : st.blocks)
      release(b);
    tables_.erase(seq);
  }

  std::uint32_t length(SeqId seq) const { return state(seq).len; }

  // True when append() can succeed without throwing (enough free blocks for
  // the worst-case allocation or copy-on-write).
  bool can_append(SeqId seq) const {
    const auto& st = state(seq);
    if (st.len % block_size_ != 0 && refcount_[st.blocks.back()] == 1)
      return true; // tail block exists and is uniquely owned
    return !free_list_.empty();
  }

  // True when set() at pos can succeed without throwing (the target block is
  // uniquely owned or a free block is available for copy-on-write).
  bool can_set(SeqId seq, std::uint32_t pos) const {
    const auto& st = state(seq);
    if (pos >= st.len)
      return false;
    if (refcount_[st.blocks[pos / block_size_]] == 1)
      return true;
    return !free_list_.empty();
  }

  // Appends one token, allocating a fresh tail block on a block boundary and
  // copying the tail block first when it is shared (copy-on-write).
  void append(SeqId seq, Token value) {
    auto& st = state(seq);
    if (st.len % block_size_ == 0) {
      st.blocks.push_back(allocate());
    } else if (refcount_[st.blocks.back()] > 1) {
      copy_on_write(st, static_cast<std::uint32_t>(st.blocks.size() - 1));
    }
    data_[slot(st.blocks.back(), st.len % block_size_)] = value;
    ++st.len;
  }

  // Random-access write; copies the target block first when it is shared.
  void set(SeqId seq, std::uint32_t pos, Token value) {
    auto& st = state(seq);
    if (pos >= st.len)
      throw std::out_of_range("set past sequence end");
    const std::uint32_t bi = pos / block_size_;
    if (refcount_[st.blocks[bi]] > 1)
      copy_on_write(st, bi);
    data_[slot(st.blocks[bi], pos % block_size_)] = value;
  }

  Token get(SeqId seq, std::uint32_t pos) const {
    const auto& st = state(seq);
    if (pos >= st.len)
      throw std::out_of_range("get past sequence end");
    return data_[slot(st.blocks[pos / block_size_], pos % block_size_)];
  }

  // Forks src into dst: dst references the same blocks read-only (each
  // block's refcount grows by one). No block is copied until someone writes.
  void fork_sequence(SeqId src, SeqId dst) {
    if (src == dst)
      throw std::invalid_argument("cannot fork a sequence onto itself");
    const auto& s = state(src);
    if (has_sequence(dst))
      throw std::invalid_argument("fork destination already exists");
    SeqState d;
    d.blocks = s.blocks;
    d.len = s.len;
    for (BlockId b : d.blocks)
      ++refcount_[b];
    tables_.emplace(dst, std::move(d));
  }

  // Beam expansion: every dst shares src's prefix blocks read-only.
  void beam_expand(SeqId src, const std::vector<SeqId>& dsts) {
    for (SeqId d : dsts)
      fork_sequence(src, d);
  }

  const std::vector<BlockId>& block_table(SeqId seq) const {
    return state(seq).blocks;
  }

  std::uint32_t refcount(BlockId b) const { return refcount_.at(b); }

  // Exact conservation audit:
  //  - every block's refcount equals the number of table slots naming it,
  //  - the free list has no duplicates and is disjoint from referenced blocks
  //    (a block is never reused before its refcount reaches zero),
  //  - every unreferenced block is on the free list (no leaks),
  //  - each table holds exactly ceil(len / block_size) blocks.
  bool check_invariants() const {
    std::vector<std::uint32_t> refs(num_blocks_, 0);
    for (const auto& [id, st] : tables_) {
      if (st.blocks.size() != (st.len + block_size_ - 1) / block_size_)
        return false;
      for (BlockId b : st.blocks) {
        if (b >= num_blocks_)
          return false;
        ++refs[b];
      }
    }
    std::vector<bool> in_free(num_blocks_, false);
    for (BlockId b : free_list_) {
      if (b >= num_blocks_ || in_free[b])
        return false;
      in_free[b] = true;
    }
    for (std::uint32_t b = 0; b < num_blocks_; ++b) {
      if (refs[b] != refcount_[b])
        return false;
      if (refs[b] > 0 && in_free[b])
        return false;
      if (refs[b] == 0 && !in_free[b])
        return false;
    }
    return true;
  }

private:
  struct SeqState {
    std::vector<BlockId> blocks;
    std::uint32_t len = 0;
  };

  SeqState& state(SeqId seq) {
    auto it = tables_.find(seq);
    if (it == tables_.end())
      throw std::out_of_range("unknown sequence");
    return it->second;
  }
  const SeqState& state(SeqId seq) const {
    auto it = tables_.find(seq);
    if (it == tables_.end())
      throw std::out_of_range("unknown sequence");
    return it->second;
  }

  std::size_t slot(BlockId b, std::uint32_t offset) const {
    return static_cast<std::size_t>(b) * block_size_ + offset;
  }

  BlockId allocate() {
    if (free_list_.empty())
      throw std::runtime_error("paged cache out of blocks");
    BlockId b = free_list_.back();
    free_list_.pop_back();
    refcount_[b] = 1;
    return b;
  }

  void release(BlockId b) {
    if (--refcount_[b] == 0)
      free_list_.push_back(b);
  }

  void copy_on_write(SeqState& st, std::uint32_t bi) {
    const BlockId old_block = st.blocks[bi];
    const BlockId new_block = allocate();
    const Token* src = &data_[slot(old_block, 0)];
    Token* dst = &data_[slot(new_block, 0)];
    for (std::uint32_t i = 0; i < block_size_; ++i)
      dst[i] = src[i];
    release(old_block);
    st.blocks[bi] = new_block;
  }

  std::uint32_t num_blocks_;
  std::uint32_t block_size_;
  std::vector<std::uint32_t> refcount_;
  std::vector<Token> data_;
  std::vector<BlockId> free_list_;
  std::unordered_map<SeqId, SeqState> tables_;
};

} // namespace dlks_formal
