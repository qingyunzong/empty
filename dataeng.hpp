#pragma once

#include <cstddef>
#include <cstdint>
#include <optional>
#include <stdexcept>
#include <string>
#include <type_traits>
#include <unordered_map>
#include <utility>
#include <vector>

namespace dataeng {

// Arrow-style signed integer index widths. Width only ever upgrades.
enum class IndexWidth : std::uint8_t { kInt8 = 1, kInt16 = 2, kInt32 = 4, kInt64 = 8 };

class UnifyError : public std::runtime_error {
 public:
  using std::runtime_error::runtime_error;
};

// Bit-packed validity, Arrow layout (LSB first).
inline bool BitmapGet(const std::uint8_t* bitmap, std::size_t i) {
  return (bitmap[i >> 3] >> (i & 7)) & 1;
}

inline void BitmapSet(std::uint8_t* bitmap, std::size_t i) {
  bitmap[i >> 3] |= static_cast<std::uint8_t>(1) << (i & 7);
}

// One incoming dictionary-encoded batch.
template <typename T>
struct DictionaryBatch {
  std::uint64_t dictionary_id = 0;
  // true: `dictionary` holds only the new values to append to the current
  // dictionary of `dictionary_id`; indices address the merged dictionary.
  bool is_delta = false;
  bool ordered = false;  // Arrow dictionary `ordered` flag
  std::vector<T> dictionary;
  std::vector<std::int64_t> indices;      // one slot per row; ignored where null
  std::vector<std::uint8_t> null_bitmap;  // bit-packed; empty means all valid
};

// A batch after unification: indices remapped into the global dictionary.
template <typename T>
struct UnifiedBatch {
  std::vector<std::int64_t> indices;      // logical remapped indices (-1 where null)
  std::vector<std::uint8_t> null_bitmap;  // always materialized, bit-packed
  std::size_t size() const { return indices.size(); }
};

// Unifies dictionary-encoded batches from many producers into one global
// dictionary plus remapped indices. Stable mode keeps first-appearance order.
template <typename T, typename Hash = std::hash<T>, typename Eq = std::equal_to<T>>
class BasicDictionaryUnifier {
 public:
  explicit BasicDictionaryUnifier(bool stable = true) : stable_(stable) {}

  // Ingests one batch and returns the slot of the unified output batch.
  std::size_t AddBatch(const DictionaryBatch<T>& batch) {
    const std::size_t rows = batch.indices.size();
    if (!batch.null_bitmap.empty() && batch.null_bitmap.size() != (rows + 7) / 8) {
      throw UnifyError("null bitmap size does not match row count");
    }

    const std::vector<T>* effective = ResolveDictionary(batch);

    UnifiedBatch<T> out;
    out.indices.resize(rows);
    out.null_bitmap.assign((rows + 7) / 8, 0);
    for (std::size_t i = 0; i < rows; ++i) {
      const bool valid =
          batch.null_bitmap.empty() || BitmapGet(batch.null_bitmap.data(), i);
      if (!valid) {
        out.indices[i] = -1;
        continue;
      }
      const std::int64_t local = batch.indices[i];
      if (local < 0 || static_cast<std::size_t>(local) >= effective->size()) {
        throw UnifyError("dictionary index out of range");
      }
      const T& value = (*effective)[static_cast<std::size_t>(local)];
      auto [memo_it, inserted] =
          memo_.emplace(value, static_cast<std::int64_t>(global_.size()));
      if (inserted) {
        global_.push_back(value);
        UpgradeWidth();
      }
      out.indices[i] = memo_it->second;
      BitmapSet(out.null_bitmap.data(), i);
    }

    ordered_ = ordered_ && batch.ordered;
    batches_.push_back(std::move(out));
    return batches_.size() - 1;
  }

  const std::vector<T>& GlobalDictionary() const { return global_; }
  const UnifiedBatch<T>& batch(std::size_t slot) const { return batches_.at(slot); }
  std::size_t BatchCount() const { return batches_.size(); }
  IndexWidth width() const { return width_; }
  bool ordered() const { return ordered_; }
  bool stable() const { return stable_; }

  // Remapped indices of one batch, materialized at integer type `Int`.
  // Throws if `Int` is narrower than the current index width.
  template <typename Int, typename = std::enable_if_t<std::is_integral_v<Int> &&
                                                      std::is_signed_v<Int>>>
  std::vector<Int> Indices(std::size_t slot) const {
    if (sizeof(Int) < static_cast<std::uint8_t>(width_)) {
      throw UnifyError("requested index type narrower than current index width");
    }
    const UnifiedBatch<T>& out = batches_.at(slot);
    std::vector<Int> result;
    result.reserve(out.indices.size());
    for (std::int64_t index : out.indices) {
      result.push_back(static_cast<Int>(index));
    }
    return result;
  }

  // Decodes a unified batch back to values through the global dictionary.
  std::vector<std::optional<T>> Decode(std::size_t slot) const {
    const UnifiedBatch<T>& out = batches_.at(slot);
    std::vector<std::optional<T>> values(out.indices.size());
    for (std::size_t i = 0; i < out.indices.size(); ++i) {
      if (BitmapGet(out.null_bitmap.data(), i)) {
        values[i] = global_.at(static_cast<std::size_t>(out.indices[i]));
      }
    }
    return values;
  }

 private:
  struct DictState {
    std::vector<T> values;  // full merged dictionary for the id
    std::uint64_t version = 0;
  };

  const std::vector<T>* ResolveDictionary(const DictionaryBatch<T>& batch) {
    auto state_it = states_.find(batch.dictionary_id);
    if (batch.is_delta) {
      // A delta only makes sense on top of the correct predecessor dictionary.
      if (state_it == states_.end()) {
        throw UnifyError("delta dictionary without predecessor for id " +
                         std::to_string(batch.dictionary_id));
      }
      DictState& state = state_it->second;
      state.values.insert(state.values.end(), batch.dictionary.begin(),
                          batch.dictionary.end());
      ++state.version;
      return &state.values;
    }
    DictState next;
    next.values = batch.dictionary;
    next.version = (state_it == states_.end()) ? 0 : state_it->second.version + 1;
    auto [it, unused] = states_.insert_or_assign(batch.dictionary_id, std::move(next));
    (void)unused;
    return &it->second.values;
  }

  void UpgradeWidth() {
    const std::size_t n = global_.size();
    IndexWidth needed = IndexWidth::kInt64;
    if (n <= (std::size_t{1} << 7)) {
      needed = IndexWidth::kInt8;
    } else if (n <= (std::size_t{1} << 15)) {
      needed = IndexWidth::kInt16;
    } else if (n <= (std::size_t{1} << 31)) {
      needed = IndexWidth::kInt32;
    }
    if (static_cast<std::uint8_t>(needed) > static_cast<std::uint8_t>(width_)) {
      width_ = needed;
    }
  }

  bool stable_;
  bool ordered_ = true;
  IndexWidth width_ = IndexWidth::kInt8;
  std::vector<T> global_;
  std::unordered_map<T, std::int64_t, Hash, Eq> memo_;
  std::unordered_map<std::uint64_t, DictState> states_;
  std::vector<UnifiedBatch<T>> batches_;
};

// Decodes an original (non-delta) batch against its own dictionary, for
// value-by-value comparison with unified output.
template <typename T>
std::vector<std::optional<T>> DecodeBatch(const DictionaryBatch<T>& batch) {
  std::vector<std::optional<T>> values(batch.indices.size());
  for (std::size_t i = 0; i < batch.indices.size(); ++i) {
    const bool valid =
        batch.null_bitmap.empty() || BitmapGet(batch.null_bitmap.data(), i);
    if (valid) {
      values[i] = batch.dictionary.at(static_cast<std::size_t>(batch.indices[i]));
    }
  }
  return values;
}

using StringDictionaryUnifier = BasicDictionaryUnifier<std::string>;

}  // namespace dataeng
