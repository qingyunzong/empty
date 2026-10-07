// Verifies pause and source-error semantics of the merger.

#include <cstdio>
#include <memory>
#include <vector>

#include "controlled_source.hpp"

namespace {

using kmerge::NextStatus;

void PauseBlocksUntilRetry() {
  auto paused = std::make_unique<ControlledSource>(std::vector{
      ControlledSource::Pause(),
      ControlledSource::Pause(),
      ControlledSource::Emit(kmerge::Record{1, 11}),
  });
  auto ready = ControlledSource::FromRecords({{2, 22}});
  std::shared_ptr<SourceStats> paused_stats = paused->stats();

  std::vector<std::unique_ptr<kmerge::Cursor>> cursors;
  cursors.push_back(std::move(paused));
  cursors.push_back(std::move(ready));
  kmerge::Merger merger(std::move(cursors));

  kmerge::NextResult res = merger.Next();
  CHECK(res.status == NextStatus::kPaused);
  CHECK(res.source == 0);
  res = merger.Next();
  CHECK(res.status == NextStatus::kPaused);
  res = merger.Next();
  CHECK(res.status == NextStatus::kRecord);
  CHECK(res.record.key == 1 && res.record.value == 11 && res.source == 0);
  res = merger.Next();
  CHECK(res.status == NextStatus::kRecord);
  CHECK(res.record.key == 2 && res.source == 1);
  res = merger.Next();
  CHECK(res.status == NextStatus::kDone);
  // Two pauses + one emit + one end-of-stream probe.
  CHECK(paused_stats->pull_count == 4);
}

void PauseSuppressesBufferedRecords() {
  // Source 0 emits key 1 then pauses; source 1 holds key 5. While source 0
  // is paused the merger must not emit source 1's buffered record, because
  // source 0's next record (key 3) sorts earlier.
  auto first = std::make_unique<ControlledSource>(std::vector{
      ControlledSource::Emit(kmerge::Record{1, 10}),
      ControlledSource::Pause(),
      ControlledSource::Emit(kmerge::Record{3, 30}),
  });
  auto second = ControlledSource::FromRecords({{5, 50}});

  std::vector<std::unique_ptr<kmerge::Cursor>> cursors;
  cursors.push_back(std::move(first));
  cursors.push_back(std::move(second));
  kmerge::Merger merger(std::move(cursors));

  kmerge::NextResult res = merger.Next();
  CHECK(res.status == NextStatus::kRecord && res.record.key == 1);
  res = merger.Next();
  CHECK(res.status == NextStatus::kPaused);
  CHECK(res.source == 0);
  res = merger.Next();
  CHECK(res.status == NextStatus::kRecord && res.record.key == 3 &&
        res.source == 0);
  res = merger.Next();
  CHECK(res.status == NextStatus::kRecord && res.record.key == 5 &&
        res.source == 1);
  res = merger.Next();
  CHECK(res.status == NextStatus::kDone);
}

void ErrorIsReportedWithSourceAndSticky() {
  auto ok = ControlledSource::FromRecords({{1, 10}, {9, 90}});
  auto bad = std::make_unique<ControlledSource>(std::vector{
      ControlledSource::Emit(kmerge::Record{2, 20}),
      ControlledSource::Fail("disk unreadable"),
  });
  std::shared_ptr<SourceStats> ok_stats = ok->stats();
  std::shared_ptr<SourceStats> bad_stats = bad->stats();

  std::vector<std::unique_ptr<kmerge::Cursor>> cursors;
  {
    cursors.push_back(std::move(ok));
    cursors.push_back(std::move(bad));
    kmerge::Merger merger(std::move(cursors));

    kmerge::NextResult res = merger.Next();
    CHECK(res.status == NextStatus::kRecord && res.record.key == 1);
    res = merger.Next();
    CHECK(res.status == NextStatus::kRecord && res.record.key == 2);
    res = merger.Next();
    CHECK(res.status == NextStatus::kError);
    CHECK(res.source == 1);
    CHECK(res.error == "disk unreadable");
    CHECK(merger.failed());
    // Sticky: further calls keep reporting the same error.
    res = merger.Next();
    CHECK(res.status == NextStatus::kError && res.source == 1 &&
          res.error == "disk unreadable");
  }
  // Destruction after failure still closes every cursor exactly once.
  CHECK(ok_stats->close_count == 1);
  CHECK(bad_stats->close_count == 1);
}

void ErrorBeforeAnyRecord() {
  auto bad = std::make_unique<ControlledSource>(
      std::vector{ControlledSource::Fail("open failed")});
  auto ok = ControlledSource::FromRecords({{1, 1}});

  std::vector<std::unique_ptr<kmerge::Cursor>> cursors;
  cursors.push_back(std::move(bad));
  cursors.push_back(std::move(ok));
  kmerge::Merger merger(std::move(cursors));

  kmerge::NextResult res = merger.Next();
  CHECK(res.status == NextStatus::kError);
  CHECK(res.source == 0);
  CHECK(res.error == "open failed");
}

}  // namespace

int main() {
  PauseBlocksUntilRetry();
  PauseSuppressesBufferedRecords();
  ErrorIsReportedWithSourceAndSticky();
  ErrorBeforeAnyRecord();
  std::puts("pause_error_test: OK");
  return 0;
}
