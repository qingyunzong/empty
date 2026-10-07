#pragma once

#include <cstddef>
#include <cstdint>
#include <memory>
#include <optional>
#include <string>
#include <utility>
#include <vector>

namespace kmerge {

struct Record {
  std::int64_t key = 0;
  std::int64_t value = 0;
};

enum class PullStatus { kOk, kPaused, kEnd, kError };

struct PullResult {
  PullStatus status = PullStatus::kEnd;
  Record record{};
  std::string error;

  static PullResult Ok(Record rec) { return {PullStatus::kOk, rec, {}}; }
  static PullResult Paused() { return {PullStatus::kPaused, {}, {}}; }
  static PullResult End() { return {PullStatus::kEnd, {}, {}}; }
  static PullResult Error(std::string msg) {
    return {PullStatus::kError, {}, std::move(msg)};
  }
};

// A Cursor yields records in non-decreasing key order.
// Pull() must return kPaused when data is temporarily unavailable; the
// merger will retry later. Close() releases underlying resources.
class Cursor {
 public:
  virtual ~Cursor() = default;
  virtual PullResult Pull() = 0;
  virtual void Close() = 0;
};

enum class NextStatus { kRecord, kPaused, kDone, kError };

struct NextResult {
  NextStatus status = NextStatus::kDone;
  Record record{};
  std::size_t source = 0;
  std::string error;

  bool is_record() const { return status == NextStatus::kRecord; }
};

// Merges K sorted cursors into a single stream ordered by (key, source
// index). Holds at most one unconsumed record per source: a source is
// pulled again only after its previously buffered record was emitted.
class Merger {
 public:
  explicit Merger(std::vector<std::unique_ptr<Cursor>> cursors) {
    slots_.reserve(cursors.size());
    for (auto& cursor : cursors) {
      slots_.push_back(Slot{std::move(cursor), {}, false, false});
    }
  }

  Merger(const Merger&) = delete;
  Merger& operator=(const Merger&) = delete;
  Merger(Merger&&) = delete;
  Merger& operator=(Merger&&) = delete;

  ~Merger() { Cancel(); }

  std::size_t size() const { return slots_.size(); }
  bool cancelled() const { return cancelled_; }
  bool failed() const { return failed_; }

  NextResult Next() {
    if (cancelled_) {
      return {NextStatus::kDone, {}, 0, {}};
    }
    if (failed_) {
      return {NextStatus::kError, {}, failed_source_, error_};
    }

    for (std::size_t i = 0; i < slots_.size(); ++i) {
      Slot& slot = slots_[i];
      if (slot.head || slot.exhausted) {
        continue;
      }
      PullResult res = slot.cursor->Pull();
      switch (res.status) {
        case PullStatus::kOk:
          slot.head = res.record;
          break;
        case PullStatus::kPaused:
          return {NextStatus::kPaused, {}, i, {}};
        case PullStatus::kEnd:
          slot.exhausted = true;
          break;
        case PullStatus::kError:
          failed_ = true;
          failed_source_ = i;
          error_ = std::move(res.error);
          return {NextStatus::kError, {}, i, error_};
      }
    }

    std::size_t best = slots_.size();
    for (std::size_t i = 0; i < slots_.size(); ++i) {
      if (!slots_[i].head) {
        continue;
      }
      if (best == slots_.size() ||
          slots_[i].head->key < slots_[best].head->key) {
        best = i;
      }
    }
    if (best == slots_.size()) {
      return {NextStatus::kDone, {}, 0, {}};
    }
    Record rec = *slots_[best].head;
    slots_[best].head.reset();
    return {NextStatus::kRecord, rec, best, {}};
  }

  // Closes every cursor exactly once; safe to call repeatedly.
  void Cancel() noexcept {
    if (cancelled_) {
      return;
    }
    cancelled_ = true;
    for (Slot& slot : slots_) {
      if (!slot.closed && slot.cursor) {
        slot.closed = true;
        slot.cursor->Close();
      }
      slot.head.reset();
    }
  }

 private:
  struct Slot {
    std::unique_ptr<Cursor> cursor;
    std::optional<Record> head;
    bool exhausted = false;
    bool closed = false;
  };

  std::vector<Slot> slots_;
  bool cancelled_ = false;
  bool failed_ = false;
  std::size_t failed_source_ = 0;
  std::string error_;
};

}  // namespace kmerge
