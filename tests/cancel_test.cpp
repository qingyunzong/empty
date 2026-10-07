// Verifies cancellation: every cursor is closed exactly once, no pulls
// happen after cancel, and each source buffers at most one unconsumed
// record.

#include <cstdio>
#include <memory>
#include <vector>

#include "controlled_source.hpp"

namespace {

using kmerge::NextStatus;

std::vector<kmerge::Record> Range(std::int64_t lo, std::int64_t hi) {
  std::vector<kmerge::Record> records;
  for (std::int64_t key = lo; key <= hi; ++key) {
    records.push_back({key, key * 10});
  }
  return records;
}

void CancelBeforeAnyRead() {
  auto a = ControlledSource::FromRecords({{1, 1}});
  auto b = ControlledSource::FromRecords({{2, 2}});
  std::shared_ptr<SourceStats> a_stats = a->stats();
  std::shared_ptr<SourceStats> b_stats = b->stats();

  std::vector<std::unique_ptr<kmerge::Cursor>> cursors;
  cursors.push_back(std::move(a));
  cursors.push_back(std::move(b));
  kmerge::Merger merger(std::move(cursors));

  merger.Cancel();
  CHECK(merger.cancelled());
  CHECK(a_stats->close_count == 1);
  CHECK(b_stats->close_count == 1);
  CHECK(a_stats->pull_count == 0);
  CHECK(b_stats->pull_count == 0);
  CHECK(merger.Next().status == NextStatus::kDone);

  // Double cancel and destructor must not close again.
  merger.Cancel();
  CHECK(a_stats->close_count == 1);
  CHECK(b_stats->close_count == 1);
}

void CancelMidStream() {
  auto a = ControlledSource::FromRecords(Range(1, 100));
  auto b = ControlledSource::FromRecords({{0, 0}});
  auto c = ControlledSource::FromRecords({});  // already exhausted path
  std::shared_ptr<SourceStats> a_stats = a->stats();
  std::shared_ptr<SourceStats> b_stats = b->stats();
  std::shared_ptr<SourceStats> c_stats = c->stats();

  std::vector<std::unique_ptr<kmerge::Cursor>> cursors;
  cursors.push_back(std::move(a));
  cursors.push_back(std::move(b));
  cursors.push_back(std::move(c));

  {
    kmerge::Merger merger(std::move(cursors));
    kmerge::NextResult res = merger.Next();
    CHECK(res.status == NextStatus::kRecord && res.record.key == 0 &&
          res.source == 1);
    res = merger.Next();
    CHECK(res.status == NextStatus::kRecord && res.record.key == 1 &&
          res.source == 0);
    merger.Cancel();
    CHECK(merger.Next().status == NextStatus::kDone);
    merger.Cancel();
  }

  CHECK(a_stats->close_count == 1);
  CHECK(b_stats->close_count == 1);
  CHECK(c_stats->close_count == 1);
  // Laziness: source 0 had 100 records available but was pulled only
  // once -- at most one unconsumed record is ever held per source.
  CHECK(a_stats->pull_count == 1);
  CHECK(b_stats->pull_count == 2);  // one record + end-of-stream
}

void DestructorClosesWithoutCancel() {
  auto a = ControlledSource::FromRecords(Range(1, 10));
  auto b = ControlledSource::FromRecords(Range(1, 10));
  std::shared_ptr<SourceStats> a_stats = a->stats();
  std::shared_ptr<SourceStats> b_stats = b->stats();

  std::vector<std::unique_ptr<kmerge::Cursor>> cursors;
  cursors.push_back(std::move(a));
  cursors.push_back(std::move(b));

  {
    kmerge::Merger merger(std::move(cursors));
    CHECK(merger.Next().status == NextStatus::kRecord);
  }
  CHECK(a_stats->close_count == 1);
  CHECK(b_stats->close_count == 1);
}

void CancelPreventsPendingError() {
  // The failing source errors on its second pull. After consuming one
  // record and cancelling, the error must never surface and the cursor
  // is closed exactly once.
  auto flaky = std::make_unique<ControlledSource>(std::vector{
      ControlledSource::Emit(kmerge::Record{5, 50}),
      ControlledSource::Fail("late failure"),
  });
  std::shared_ptr<SourceStats> flaky_stats = flaky->stats();

  std::vector<std::unique_ptr<kmerge::Cursor>> cursors;
  cursors.push_back(std::move(flaky));
  kmerge::Merger merger(std::move(cursors));

  kmerge::NextResult res = merger.Next();
  CHECK(res.status == NextStatus::kRecord && res.record.key == 5);
  merger.Cancel();
  CHECK(merger.Next().status == NextStatus::kDone);
  CHECK(!merger.failed());
  CHECK(flaky_stats->close_count == 1);
  CHECK(flaky_stats->pull_count == 1);
}

}  // namespace

int main() {
  CancelBeforeAnyRead();
  CancelMidStream();
  DestructorClosesWithoutCancel();
  CancelPreventsPendingError();
  std::puts("cancel_test: OK");
  return 0;
}
