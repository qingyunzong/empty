#pragma once

// Test helper: a scripted Cursor with observable Pull/Close counters.

#include <cstdio>
#include <cstdlib>
#include <memory>
#include <string>
#include <utility>
#include <vector>

#include "kmerge/kmerge.hpp"

#define CHECK(cond)                                                       \
  do {                                                                    \
    if (!(cond)) {                                                        \
      std::fprintf(stderr, "CHECK failed at %s:%d: %s\n", __FILE__,       \
                   __LINE__, #cond);                                      \
      std::abort();                                                       \
    }                                                                     \
  } while (0)

// Counters live outside the cursor so tests can inspect them after the
// merger (which owns the cursors) has been destroyed.
struct SourceStats {
  int pull_count = 0;
  int close_count = 0;
};

class ControlledSource : public kmerge::Cursor {
 public:
  struct Step {
    enum Kind { kEmit, kPause, kFail } kind;
    kmerge::Record record{};
    std::string message;
  };

  static Step Emit(kmerge::Record rec) { return {Step::kEmit, rec, {}}; }
  static Step Pause() { return {Step::kPause, {}, {}}; }
  static Step Fail(std::string msg) {
    return {Step::kFail, {}, std::move(msg)};
  }

  explicit ControlledSource(std::vector<Step> steps)
      : steps_(std::move(steps)) {}

  std::shared_ptr<SourceStats> stats() const { return stats_; }

  // Builds a source emitting the given records, then kEnd.
  static std::unique_ptr<ControlledSource> FromRecords(
      std::vector<kmerge::Record> records) {
    std::vector<Step> steps;
    steps.reserve(records.size());
    for (kmerge::Record rec : records) {
      steps.push_back(Emit(rec));
    }
    return std::make_unique<ControlledSource>(std::move(steps));
  }

  kmerge::PullResult Pull() override {
    ++stats_->pull_count;
    if (closed_) {
      std::fprintf(stderr, "Pull() called after Close()\n");
      std::abort();
    }
    if (pos_ >= steps_.size()) {
      return kmerge::PullResult::End();
    }
    const Step& step = steps_[pos_];
    switch (step.kind) {
      case Step::kEmit:
        ++pos_;
        return kmerge::PullResult::Ok(step.record);
      case Step::kPause:
        ++pos_;
        return kmerge::PullResult::Paused();
      case Step::kFail:
        ++pos_;
        return kmerge::PullResult::Error(step.message);
    }
    std::abort();
  }

  void Close() override {
    ++stats_->close_count;
    closed_ = true;
  }

 private:
  std::vector<Step> steps_;
  std::size_t pos_ = 0;
  bool closed_ = false;
  std::shared_ptr<SourceStats> stats_ = std::make_shared<SourceStats>();
};

// Drains the merger to completion, retrying through pauses.
inline std::vector<kmerge::NextResult> Drain(kmerge::Merger& merger) {
  std::vector<kmerge::NextResult> out;
  for (;;) {
    kmerge::NextResult res = merger.Next();
    if (res.status == kmerge::NextStatus::kPaused) {
      continue;
    }
    if (res.status == kmerge::NextStatus::kRecord) {
      out.push_back(res);
      continue;
    }
    return out;
  }
}
