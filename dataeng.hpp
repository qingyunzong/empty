#pragma once

#include <algorithm>
#include <cstdint>
#include <filesystem>
#include <optional>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

namespace dataeng {

// A normalized whole table row, encoded as raw bytes.
using Row = std::string;

// Strong 128-bit digest of a normalized row. The digest is only a
// pre-filter: rows are always confirmed against their raw value, so
// digest collisions never merge distinct rows.
struct Digest {
  std::uint64_t hi = 0;
  std::uint64_t lo = 0;
  bool operator==(const Digest&) const = default;
};

// Total order used everywhere: digest first, then raw row bytes.
inline int compare_digest(const Digest& a, const Digest& b) {
  if (a.hi != b.hi) return a.hi < b.hi ? -1 : 1;
  if (a.lo != b.lo) return a.lo < b.lo ? -1 : 1;
  return 0;
}

inline int compare_keys(const Digest& da, const Row& ra, const Digest& db,
                        const Row& rb) {
  if (int c = compare_digest(da, db)) return c;
  if (ra < rb) return -1;
  if (rb < ra) return 1;
  return 0;
}

// Default strong hasher: MurmurHash3 x64 128-bit (non-cryptographic).
struct StrongHasher {
  Digest operator()(const Row& row) const;
};

// One distinct row value and its multiplicity.
struct RowCount {
  Row row;
  std::uint64_t count = 0;
  bool operator==(const RowCount&) const = default;
};

// Multiset difference between two snapshots. Both lists are sorted by
// (digest, row) so results are deterministic and directly comparable
// across the in-memory and external-sort code paths.
struct DiffResult {
  std::vector<RowCount> inserts;  // multiplicity higher in the new snapshot
  std::vector<RowCount> deletes;  // multiplicity higher in the old snapshot
  bool operator==(const DiffResult&) const = default;
};

namespace detail {

struct CountEntry {
  Digest digest;
  Row row;
  std::uint64_t count = 0;
};

inline int compare_entries(const CountEntry& a, const CountEntry& b) {
  return compare_keys(a.digest, a.row, b.digest, b.row);
}

struct DigestHash {
  std::size_t operator()(const Digest& d) const {
    return static_cast<std::size_t>(d.hi ^ (d.lo * 0x9E3779B97F4A7C15ull));
  }
};

// Merge-join two sorted streams of per-value counts into a DiffResult.
// Each puller returns the next CountEntry in (digest, row) order.
template <typename OldNext, typename NewNext>
DiffResult join_entry_streams(OldNext old_next, NewNext new_next) {
  DiffResult result;
  std::optional<CountEntry> old_entry = old_next();
  std::optional<CountEntry> new_entry = new_next();
  while (old_entry || new_entry) {
    int cmp = !old_entry ? 1
              : !new_entry ? -1
                           : compare_entries(*old_entry, *new_entry);
    if (cmp == 0) {
      if (new_entry->count > old_entry->count) {
        result.inserts.push_back(
            {new_entry->row, new_entry->count - old_entry->count});
      } else if (old_entry->count > new_entry->count) {
        result.deletes.push_back(
            {old_entry->row, old_entry->count - new_entry->count});
      }
      old_entry = old_next();
      new_entry = new_next();
    } else if (cmp < 0) {
      result.deletes.push_back({old_entry->row, old_entry->count});
      old_entry = old_next();
    } else {
      result.inserts.push_back({new_entry->row, new_entry->count});
      new_entry = new_next();
    }
  }
  return result;
}

}  // namespace detail

// In-memory multiset of rows with duplicate counting. Rows are bucketed
// by digest and confirmed by exact raw-value comparison, so hash
// collisions never merge distinct values.
template <typename Hasher = StrongHasher>
class MultisetCounter {
public:
  void add(const Row& row) { add_impl(row); }
  void add(Row&& row) { add_impl(std::move(row)); }

  // Per-value counts sorted by (digest, row).
  std::vector<detail::CountEntry> entries() const {
    std::vector<detail::CountEntry> out;
    out.reserve(buckets_.size());
    for (const auto& [digest, bucket] : buckets_) {
      for (const auto& [row, count] : bucket) {
        out.push_back({digest, row, count});
      }
    }
    std::sort(out.begin(), out.end(), [](const auto& a, const auto& b) {
      return detail::compare_entries(a, b) < 0;
    });
    return out;
  }

private:
  template <typename R>
  void add_impl(R&& row) {
    Digest digest = hasher_(row);
    auto& bucket = buckets_[digest];
    for (auto& [existing, count] : bucket) {
      if (existing == row) {
        ++count;
        return;
      }
    }
    bucket.emplace_back(std::forward<R>(row), 1);
  }

  using Bucket = std::vector<std::pair<Row, std::uint64_t>>;
  std::unordered_map<Digest, Bucket, detail::DigestHash> buckets_;
  Hasher hasher_{};
};

// Multiset diff of two in-memory counters.
template <typename Hasher = StrongHasher>
DiffResult diff_counters(const MultisetCounter<Hasher>& old_counter,
                         const MultisetCounter<Hasher>& new_counter) {
  auto old_entries = old_counter.entries();
  auto new_entries = new_counter.entries();
  auto old_it = old_entries.begin();
  auto new_it = new_entries.begin();
  return detail::join_entry_streams(
      [&]() -> std::optional<detail::CountEntry> {
        if (old_it == old_entries.end()) return std::nullopt;
        return *old_it++;
      },
      [&]() -> std::optional<detail::CountEntry> {
        if (new_it == new_entries.end()) return std::nullopt;
        return *new_it++;
      });
}

// Convenience: in-memory diff of two snapshots given as row ranges.
template <typename Hasher = StrongHasher, typename Iter>
DiffResult diff_snapshots(Iter old_begin, Iter old_end, Iter new_begin,
                          Iter new_end) {
  MultisetCounter<Hasher> old_counter, new_counter;
  for (auto it = old_begin; it != old_end; ++it) old_counter.add(*it);
  for (auto it = new_begin; it != new_end; ++it) new_counter.add(*it);
  return diff_counters(old_counter, new_counter);
}

// Options for the external-sort diff path used by large partitions.
struct ExternalOptions {
  // Directory for temporary sorted-run files (e.g. $TMPDIR).
  std::filesystem::path spill_dir;
  // Approximate byte budget for one in-memory sort run.
  std::size_t memory_budget_bytes = 64ull << 20;
  // Maximum number of runs merged in a single pass.
  std::size_t merge_fan_in = 64;
};

namespace detail {

// Binary sorted-run file I/O. Record: u64 hi, u64 lo, u32 len, bytes.
class RunWriter {
public:
  explicit RunWriter(const std::filesystem::path& path);
  ~RunWriter();
  RunWriter(const RunWriter&) = delete;
  RunWriter& operator=(const RunWriter&) = delete;
  void write(const Digest& digest, const Row& row);
  void close();

private:
  struct Impl;
  Impl* impl_;
};

class RunReader {
public:
  explicit RunReader(const std::filesystem::path& path);
  ~RunReader();
  RunReader(const RunReader&) = delete;
  RunReader& operator=(const RunReader&) = delete;
  bool next(Digest& digest, Row& row);  // false at end of run

private:
  struct Impl;
  Impl* impl_;
};

std::filesystem::path make_temp_run_path(const std::filesystem::path& dir);

// Merges sorted runs in passes until at most fan_in runs remain.
// Intermediate files are removed as they are consumed.
void reduce_runs(std::vector<std::filesystem::path>& runs,
                 std::size_t fan_in, const std::filesystem::path& dir);

// Pull-based k-way merge reader over a set of sorted runs.
class MergedRunReader {
public:
  explicit MergedRunReader(std::vector<std::filesystem::path> runs);
  ~MergedRunReader();
  MergedRunReader(const MergedRunReader&) = delete;
  MergedRunReader& operator=(const MergedRunReader&) = delete;
  bool next(Digest& digest, Row& row);

private:
  struct Impl;
  Impl* impl_;
};

// Removes run files unless dismissed.
class RunFileGuard {
public:
  explicit RunFileGuard(std::vector<std::filesystem::path>* files)
      : files_(files) {}
  ~RunFileGuard() {
    if (!files_) return;
    for (const auto& path : *files_) {
      std::error_code ec;
      std::filesystem::remove(path, ec);
    }
  }
  void dismiss() { files_ = nullptr; }

private:
  std::vector<std::filesystem::path>* files_;
};

}  // namespace detail

// Spills one snapshot into sorted run files under opts.spill_dir.
template <typename Hasher, typename Iter>
std::vector<std::filesystem::path> build_runs(Iter begin, Iter end,
                                              const ExternalOptions& opts) {
  Hasher hasher;
  std::vector<std::filesystem::path> runs;
  std::vector<std::pair<Digest, Row>> buffer;
  std::size_t buffered_bytes = 0;
  auto flush = [&]() {
    if (buffer.empty()) return;
    std::sort(buffer.begin(), buffer.end(), [](const auto& a, const auto& b) {
      return compare_keys(a.first, a.second, b.first, b.second) < 0;
    });
    auto path = detail::make_temp_run_path(opts.spill_dir);
    {
      detail::RunWriter writer(path);
      for (const auto& [digest, row] : buffer) writer.write(digest, row);
    }
    runs.push_back(std::move(path));
    buffer.clear();
    buffered_bytes = 0;
  };
  for (auto it = begin; it != end; ++it) {
    const Row& row = *it;
    buffered_bytes += sizeof(Digest) + row.size() + sizeof(Row);
    buffer.emplace_back(hasher(row), row);
    if (buffered_bytes >= opts.memory_budget_bytes) flush();
  }
  flush();
  return runs;
}

// External-sort multiset diff for large partitions. Produces exactly the
// same DiffResult as the in-memory counting model.
template <typename Hasher = StrongHasher, typename Iter>
DiffResult diff_snapshots_external(Iter old_begin, Iter old_end,
                                   Iter new_begin, Iter new_end,
                                   const ExternalOptions& opts) {
  std::vector<std::filesystem::path> old_runs =
      build_runs<Hasher>(old_begin, old_end, opts);
  detail::RunFileGuard old_guard(&old_runs);
  std::vector<std::filesystem::path> new_runs =
      build_runs<Hasher>(new_begin, new_end, opts);
  detail::RunFileGuard new_guard(&new_runs);

  detail::reduce_runs(old_runs, opts.merge_fan_in, opts.spill_dir);
  detail::reduce_runs(new_runs, opts.merge_fan_in, opts.spill_dir);

  detail::MergedRunReader old_reader(std::move(old_runs));
  detail::MergedRunReader new_reader(std::move(new_runs));
  old_runs.clear();
  new_runs.clear();

  // Aggregate equal (digest, row) records on the fly and merge-join.
  auto make_puller = [](detail::MergedRunReader& reader) {
    return [pending = std::optional<detail::CountEntry>{},
            &reader]() mutable -> std::optional<detail::CountEntry> {
      Digest digest;
      Row row;
      while (reader.next(digest, row)) {
        if (pending && pending->digest == digest && pending->row == row) {
          ++pending->count;
        } else {
          auto finished = std::move(pending);
          pending = detail::CountEntry{digest, row, 1};
          if (finished) return finished;
        }
      }
      return std::exchange(pending, std::nullopt);
    };
  };
  return detail::join_entry_streams(make_puller(old_reader),
                                    make_puller(new_reader));
}

}  // namespace dataeng
